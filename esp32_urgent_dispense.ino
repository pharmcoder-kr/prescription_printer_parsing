// ===== Part 1: 선언부 및 FreeRTOS 태스크 구현 =====

#include <WiFi.h>
#include <EEPROM.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <queue>
#include <TMCStepper.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>

// ── 펌웨어 버전 정보 ────────────────────────────────────────────────────────────
#define FIRMWARE_VERSION "1.1.1"

#define DIR_PIN      25    // 스텝모터 DIR
#define STEP_PIN     33    // 스텝모터 STEP
#define EN_PIN       13    // 스텝모터 ENABLE (LOW = ON)
#define UART_TX      17    // 스텝모터 UART TX
#define LIMIT_PIN    12    // 리미트 스위치 (INPUT_PULLUP)
#define R_SENSE      0.11f // 전류 감지 저항
#define DRIVER_ADDR  0b00  // UART 주소
#define SENSOR_D0_PIN  23  // A0/D0 센서 → ESP32 GPIO23

// 로드셀 미연결 시 분주 방지 (I2C 저울/ADC 주소, 사용 보드에 맞게 변경)
#define LOADCELL_I2C_ADDR  0x40
// 펌프 최대 가동 시간(ms): 이 시간 초과 시 강제 정지 (목표 도달 실패 시 대참사 방지)
#define PUMP_SAFETY_MAX_MS 120000

HardwareSerial  TMCserial(2);
TMC2209Stepper  driver(&TMCserial, R_SENSE, DRIVER_ADDR);

#define NEXTION_RX 18
#define NEXTION_TX 19
HardwareSerial nextion(1);
WiFiServer server(80);

// EEPROM addresses
#define ADDR_SSID      0
#define ADDR_PASSWORD 32
#define ADDR_FLAG     100
#define VALID_FLAG    0xA5
#define ADDR_VOLUME   128
#define ADDR_MARGIN   132
#define ADDR_RATE      136
#define ADDR_RATE100   140
#define ADDR_RATE60    144
#define ADDR_RATE30    148

#define CAL_SEC_30   2.0f
#define CAL_SEC_60   3.0f
#define CAL_SEC_100  5.0f

enum DispenseState {
  DSP_IDLE, DSP_HOMING, DSP_HOMED_WAIT, DSP_MOVE, DSP_MOVE_WAIT,
  DSP_PUMP, DSP_PUMP_WAIT, DSP_RETURN, DSP_RETURN_WAIT,
  DSP_COMPLETE, DSP_WAIT_CONFIRM
};

DispenseState dspState = DSP_WAIT_CONFIRM;
unsigned long dspTimer = 0;
uint32_t dspPumpDuration = 0;

// 전역에 추가
bool isProcessing = true;
// ── 전역 플래그 ───────────────────────────────────────────────────────────
bool pageSwitchedToProcess = false;  // 이 줄을 추가하세요
// 전역 변수 추가
volatile bool isDispenseReady = false;

String ssidList[6];
String selectedSSID;
String wifiPassword;
String inputBuffer;
bool readyToConnect = false;
int ffCount = 0;

int volumeFlag = 0;
int marginFlag = 0;
int U_volume = 0;
int S_offset = 0;
float rate_mL_per_sec = 1.0f;
int rateFlag = 0;
int rate100Flag = 0;
int rate60Flag = 0;
int rate30Flag = 0;

enum State { IDLE, FIXED_PUMP };
State currentState = IDLE;

const uint32_t STEPS1 = 6320;
const uint32_t STEPS2 = 4530;
const uint32_t STEPS3 = 2550;
const uint16_t STEP_US = 50;

#define PUMP_EN    26
#define PUMP_PWM   27

struct Job {
  int volume;
  int margin;
  String patient_name;
  bool isUrgent;  // 긴급 작업 플래그 추가
};
std::queue<Job> jobQueue;

SemaphoreHandle_t jobQueueMutex;
TaskHandle_t dispenseTaskHandle;
TaskHandle_t httpTaskHandle;
TaskHandle_t hmiTaskHandle;
TaskHandle_t scaleTaskHandle;

// TARE 비블로킹: HMI가 멈추지 않도록 별도 태스크에서 수행
volatile bool tareRequested = false;
volatile bool tareResultReady = false;
volatile int32_t tareResultValue = 0;
volatile bool tareFailed = false;
// 100mL 당 g (p100G 등으로 설정)
int scaleGramPer100mL = 100;

// forward declarations
void handleClient(WiFiClient &client);
void doHoming();
void moveSteps(uint32_t steps, bool forward);
inline void stepPulse();
void runPumpForVolume(int mL);
void switchPage(const String &pageName);
void updateJobQueueDisplay();
bool isLoadCellConnected();
void stopPumpNow();
void scaleTask(void* pvParameters);

// ── 로드셀 연결 여부 (I2C 프로브) ─────────────────────────
bool isLoadCellConnected() {
  Wire.beginTransmission((uint8_t)LOADCELL_I2C_ADDR);
  uint8_t err = Wire.endTransmission();
  if (err == 0) return true;
  delay(5);
  Wire.beginTransmission((uint8_t)LOADCELL_I2C_ADDR);
  err = Wire.endTransmission();
  return (err == 0);
}

// ── 펌프 즉시 정지 ───────────────────────────────────────
void stopPumpNow() {
  digitalWrite(PUMP_PWM, LOW);
  digitalWrite(PUMP_EN, LOW);
}

// ── 스케일(로드셀) 전용 태스크: TARE를 여기서 수행해 HMI 태스크가 블로킹되지 않음 ──
// 사용 보드가 TARE 명령(Write) 후 Read 하는 방식이면 이 루프를 해당 프로토콜로 교체
#define TARE_TIMEOUT_MS 2000
void scaleTask(void* pvParameters) {
  for (;;) {
    if (tareRequested) {
      tareRequested = false;
      tareFailed = false;
      tareResultReady = false;
      if (!isLoadCellConnected()) {
        tareFailed = true;
        tareResultValue = 0;
        tareResultReady = true;
      } else {
        unsigned long t0 = millis();
        bool ok = false;
        while (millis() - t0 < TARE_TIMEOUT_MS) {
          Wire.requestFrom((uint8_t)LOADCELL_I2C_ADDR, (uint8_t)4);
          if (Wire.available() >= 4) {
            uint8_t b[4];
            for (int i = 0; i < 4; i++) b[i] = Wire.read();
            // Big-endian; 장치에 맞게 little-endian 등으로 변경 가능
            tareResultValue = (int32_t)((b[0]<<24) | (b[1]<<16) | (b[2]<<8) | b[3]);
            ok = true;
            break;
          }
          vTaskDelay(pdMS_TO_TICKS(50));
        }
        if (!ok) {
          tareFailed = true;
          tareResultValue = 0;
        }
        tareResultReady = true;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

// ── Nextion 페이지 전환 ─────────────────────────────────────────────────
void switchPage(const String &pageName) {
  nextion.print("page " + pageName);
  nextion.write(0xFF);
  nextion.write(0xFF);
  nextion.write(0xFF);
}

// ── 작업 대기열 Nextion 표시 갱신 ────────────────────────────────────────────
void updateJobQueueDisplay() {
  if (xSemaphoreTake(jobQueueMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
    std::queue<Job> tmp = jobQueue;
    for (int i = 0; i < 7; i++) {
      String txt = "";
      if (!tmp.empty()) {
        Job j = tmp.front(); tmp.pop();
        String label = (i == 0 ? "1st" :
                        i == 1 ? "2nd" :
                        i == 2 ? "3rd" :
                        String(i+1) + "th");
        String urgentMark = j.isUrgent ? " [긴급]" : "";
        txt = label + " " + j.patient_name + " " + String(j.volume) + "mL" + urgentMark;
      }
      String cmd = "process.t" + String(i+2) + ".txt=\"" + txt + "\"";
      sendToNextion(cmd);
    }
    xSemaphoreGive(jobQueueMutex);
  }
}

// pR 처리 전용 함수
void handleNextionPR() {
  // 완료 확인 상태였다면 리셋
  if (dspState == DSP_WAIT_CONFIRM) {
    dspState = DSP_IDLE;
    pageSwitchedToProcess = false;
  }
  // 항상 "조제준비" 누르면 프로세싱 모드로 진입
  isProcessing = true;
  // 큐에 작업이 남았는지 확인
  xSemaphoreTake(jobQueueMutex, pdMS_TO_TICKS(100));
  bool hasJob = !jobQueue.empty();
  xSemaphoreGive(jobQueueMutex);

  if (!isProcessing && hasJob) {
    // 처음 pR → 분주 시작
    isProcessing = true;
    isDispenseReady = true;
    switchPage("process");
  }
  else if (isProcessing && hasJob) {
    // 완료 후 pR → 다음 분주
    isDispenseReady = true;
    switchPage("process");
  }
  else {
    // 큐 비었으면 키패드로
    isProcessing = false;
    switchPage("keypad");
  }
  updateJobQueueDisplay();
}

// ── HTTP 서버 태스크 ─────────────────────────────────────────────────────────
void httpServerTask(void* pvParameters) {
  for (;;) {
    WiFiClient client = server.available();
    if (client) handleClient(client);
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

void scanWiFi() {
  //WiFi.disconnect(true, true);
  //delay(100);
  //WiFi.mode(WIFI_STA);  
  Serial.println("📡 WiFi 스캔 시작");
  int n = WiFi.scanNetworks(false, true);
  Serial.println("📡 스캔 완료, 네트워크 수: " + String(n));
  if (n == 0) {
    sendToNextion("page0.t1.txt=\"No networks\"");
  } else {
    for (int i = 0; i < n && i < 6; i++) {
      ssidList[i] = WiFi.SSID(i);
      sendToNextion("page0.t" + String(i+1) + ".txt=\"" + ssidList[i] + "\"");
      sendToNextion("page0.t" + String(i+1) + ".style=3");
    }
  }
}

// ── HMI(Nextion) 처리 태스크 ─────────────────────────────────────────────────
void hmiTask(void* pvParameters) {
  for (;;) {
    bool handled = false;

    // TARE 결과 수신 (scale 태스크에서 완료 시 여기서 한 번만 전송, HMI 블로킹 없음)
    if (tareResultReady) {
      tareResultReady = false;
      if (tareFailed) {
        Serial.println("⚠️ TARE 실패 (로드셀 미연결/타임아웃)");
        sendToNextion("tare.txt=\"실패\"");
      } else {
        Serial.println("✅ TARE 완료: " + String(tareResultValue));
        sendToNextion("tare.txt=\"" + String(tareResultValue) + "\"");
      }
    }

    // Nextion으로부터 들어오는 바이트 처리
    while (nextion.available()) {
      uint8_t c = nextion.read();

      // 터치 노이즈 등 제어문자(0x00~0x1F) 무시, 단 종료 바이트(0xFF)는 처리
      if (c < 0x20 && c != 0xFF) {
        ffCount = 0;
        continue;
      }

      if (c == 0xFF) {
        // 0xFF 세 번 연속 수신 시 커맨드 끝
        if (++ffCount == 3) {
          ffCount = 0;

          // 완성된 명령어 파싱
          inputBuffer.trim();
          inputBuffer.replace("\r", "");
          inputBuffer.replace("\n", "");
          inputBuffer.replace("\0", "");

          if (inputBuffer.length() > 0) {
            Serial.println("📩 수신된 명령: " + inputBuffer);

            if (inputBuffer == "pR") {
              Serial.println("🔁 pR 수신");
              handleNextionPR();
              inputBuffer = "";
              ffCount = 0;
            }
            // --- pZ : TARE (영점) - 별도 태스크에서 수행해 HMI 블로킹 방지 ---
            else if (inputBuffer == "pZ") {
              Serial.println("🔄 TARE 시작...");
              if (!isLoadCellConnected()) {
                Serial.println("⚠️ TARE 실패: 로드셀 미연결");
                sendToNextion("tare.txt=\"실패\"");
              } else {
                tareRequested = true;
              }
            }
            // --- pNNG : 100mL 당 g 설정 (예: p100G) ---
            else if (inputBuffer.length() >= 3 && inputBuffer[0] == 'p' && inputBuffer.endsWith("G")) {
              int g = inputBuffer.substring(1, inputBuffer.length() - 1).toInt();
              scaleGramPer100mL = (g > 0) ? g : 100;
              Serial.println("💧 100mL 당 g 설정: " + String(scaleGramPer100mL));
            }
            // --- pL ---
            else if (inputBuffer == "pL") {
              Serial.println("📋 pL 수신");
            }

            // --- pU : 목표 분주량 설정 ---
            else if (inputBuffer.endsWith("U")) {
              U_volume = inputBuffer.substring(1, inputBuffer.length() - 1).toInt();
              Serial.println("📐 목표 분주량: " + String(U_volume) + " mL");
              sendToNextion("tPump.txt=\"Vol=" + String(U_volume) + "mL\"");
            }
            // --- pD : 속도 설정 (mL/5s → mL/s) ---
            else if (inputBuffer.endsWith("D")) {
              int x = inputBuffer.substring(1, inputBuffer.length() - 1).toInt();
              rateFlag = x;
              rate_mL_per_sec = (x > 0) ? (float)x / 5.0f : 0;
              saveFlagsToEEPROM();
              Serial.println("⚖️ 속도: " + String(rate_mL_per_sec, 2) + " mL/s");
              sendToNextion("tPump.txt=\"Rate=" + String(rate_mL_per_sec, 2) + "mL/s\"");
            }
            // --- pS : 오프셋 설정 ---
            else if (inputBuffer.endsWith("S")) {
              S_offset = inputBuffer.substring(1, inputBuffer.length() - 1).toInt();
              Serial.println("➕ Offset: " + String(S_offset) + " mL");
              sendToNextion("tPump.txt=\"Offset=" + String(S_offset) + "mL\"");
            }
            // --- pF : WiFi 리스트 새로고침 ---
            else if (inputBuffer == "pF") {
              Serial.println("♻️ WiFi 리스트 새로고침 요청");
              scanWiFi();
            }
            // --- pP : 수동 분주 시작 ---
            else if (inputBuffer == "pP") {
              Job newJob = { U_volume, S_offset, "수동조제", false };
              if (xSemaphoreTake(jobQueueMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                jobQueue.push(newJob);
                xSemaphoreGive(jobQueueMutex);
              }
              Serial.println("✅ 수동 작업 대기열 추가");
                // 2) 현재 아무 작업도 안 돌고 있으면(=키패드 화면) 즉시 시작
              if (!isProcessing) {
                // 분주 준비 플래그 세팅
                isProcessing    = true;
                isDispenseReady = true;
                // PROCESS 화면으로 전환
                switchPage("process");
              }
            }
            // --- A/F/G/B: 설정 저장 (100/60/30mL 속도, margin) ---
            else if (inputBuffer.endsWith("A")) {
              rate100Flag = inputBuffer.substring(1, inputBuffer.length() - 1).toInt();
              saveFlagsToEEPROM();
              sendToNextion("setting.n0.val=" + String(rate100Flag));
              Serial.println("💾 100 mL 속도 저장: " + String(rate100Flag));
            }
            else if (inputBuffer.endsWith("F")) {
              rate60Flag = inputBuffer.substring(1, inputBuffer.length() - 1).toInt();
              saveFlagsToEEPROM();
              sendToNextion("setting.n2.val=" + String(rate60Flag));
              Serial.println("💾 60 mL 속도 저장: " + String(rate60Flag));
            }
            // ── hmiTask() 내부, pSSID/password 처리 바로 아래에 추가 ────────────────────
            else if (inputBuffer == "pWIFI") {
              // "연결" 버튼이 눌렸을 때 이 명령이 들어온다고 가정
              Serial.println("🔑 pWIFI 수신 → 실제 WiFi 연결 시도");
              connectToWiFi();
              // 초기화
              readyToConnect = false;
            }
            
            else if (inputBuffer.endsWith("G")) {
              rate30Flag = inputBuffer.substring(1, inputBuffer.length() - 1).toInt();
              saveFlagsToEEPROM();
              sendToNextion("setting.n3.val=" + String(rate30Flag));
              Serial.println("💾 30 mL 속도 저장: " + String(rate30Flag));
            }
            else if (inputBuffer.endsWith("B")) {
              marginFlag = inputBuffer.substring(1, inputBuffer.length() - 1).toInt();
              saveFlagsToEEPROM();
              sendToNextion("setting.n1.val=" + String(marginFlag));
              Serial.println("💾 Margin 저장: " + String(marginFlag));
            }
            // --- SSID 선택 / 비번 입력 처리 ---
            else if (inputBuffer.startsWith("pSSID")) {
              int idx = inputBuffer.substring(5).toInt();
              if (idx >= 1 && idx <= 6) {
                selectedSSID = ssidList[idx - 1];
                Serial.println("🔑 SSID 선택: " + selectedSSID);
              }
            }
            else if (inputBuffer.endsWith("password")) {
              wifiPassword = inputBuffer.substring(1, inputBuffer.length() - 8);
              wifiPassword.trim();
              readyToConnect = true;
              Serial.println("🔐 Password 입력 완료");
            }
          } // if inputBuffer.length > 0

          // 버퍼 초기화
          inputBuffer = "";
        } // if ffCount == 3
      }
      else {
        // 0xFF가 아닌 데이터 바이트는 명령어 버퍼에 저장
        inputBuffer += (char)c;
        ffCount = 0;
      }

      if (handled) break;
    } // while nextion.available()

    // 짧게 대기하여 다른 태스크에 CPU 양보
    vTaskDelay(pdMS_TO_TICKS(10));
  } // for(;;)
}

void dispenseTask(void* parameter) {
  while (true) {
    // 1) 준비 신호(pS) 올 때까지 대기
    if (!isDispenseReady) {
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }

    // 2) 큐에서 작업 꺼내기
    Job currentJob;
    bool hasJob = false;
    if (xSemaphoreTake(jobQueueMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
      if (!jobQueue.empty()) {
        currentJob = jobQueue.front();
        jobQueue.pop();
        hasJob = true;
      }
      xSemaphoreGive(jobQueueMutex);
    }

    if (!hasJob) {
      // 작업이 없으면 다음 준비 신호를 기다림
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }
    // 준비 신호 소비
    isDispenseReady = false;
    // 3) 실제 분주 로직 시작
    U_volume = currentJob.volume;
    S_offset = currentJob.margin;
    switchPage("process");
        // ← 이 줄 다음에 추가
    sendToNextion(
      "process.g0.txt=\"" +
      currentJob.patient_name +
      "  " +
      String(U_volume) +
      "mL" +
      (currentJob.isUrgent ? " [긴급]" : "") +
      "\""
    );
    dspState = DSP_HOMING;
    updateJobQueueDisplay();

    // 로드셀 미연결 시 분주 금지 (펌프 무한 가동 대참사 방지)
    if (!isLoadCellConnected()) {
      stopPumpNow();
      sendToNextion("process.g0.txt=\"로드셀 미연결!\"");
      Serial.println("⚠️ 로드셀 미연결 - 분주 중단");
      dspState = DSP_WAIT_CONFIRM;
    }

    while (dspState != DSP_IDLE && dspState != DSP_WAIT_CONFIRM) {
      switch (dspState) {
        case DSP_HOMING:
          doHoming();
          dspTimer = millis();
          dspState = DSP_HOMED_WAIT;
          break;

        case DSP_HOMED_WAIT:
          if (millis() - dspTimer >= 200) dspState = DSP_MOVE;
          break;

        case DSP_MOVE: {
            uint32_t steps = (U_volume <= 30 ? STEPS1
                              : U_volume <= 60 ? STEPS2
                                               : STEPS3);
            moveSteps(steps, true);
            dspTimer = millis();
            dspState = DSP_MOVE_WAIT;
          }
          break;

        case DSP_MOVE_WAIT:
          if (millis() - dspTimer >= 500) {
            if (digitalRead(SENSOR_D0_PIN) == LOW) {
              float speed = (U_volume <= 30 && rate30Flag > 0) ? rate30Flag / 5.0f
                              : (U_volume <= 60 && rate60Flag > 0) ? rate60Flag / 5.0f
                                                                     : rate100Flag / 5.0f;
              dspPumpDuration = (uint32_t)(U_volume / speed * 1000.0f);
              digitalWrite(PUMP_EN, HIGH);
              digitalWrite(PUMP_PWM, HIGH);
              dspTimer = millis();
              dspState = DSP_PUMP_WAIT;
            } else {
              dspState = DSP_RETURN;
            }
          }
          break;

        case DSP_PUMP_WAIT: {
          unsigned long elapsed = millis() - dspTimer;
          // 정상 종료: 목표 시간 도달
          if (elapsed >= dspPumpDuration) {
            stopPumpNow();
            dspState = DSP_RETURN;
            break;
          }
          // 안전 타임아웃: 목표 도달 실패 시 펌프 무한 가동 방지
          if (elapsed > PUMP_SAFETY_MAX_MS) {
            stopPumpNow();
            sendToNextion("process.g0.txt=\"펌프 타임아웃!\"");
            Serial.println("⚠️ 펌프 안전 타임아웃 - 강제 정지");
            dspState = DSP_RETURN;
          }
          break;
        }

        case DSP_RETURN:
          doHoming();
          dspTimer = millis();
          dspState = DSP_RETURN_WAIT;
          break;

        case DSP_RETURN_WAIT:
          if (millis() - dspTimer >= 200) dspState = DSP_COMPLETE;
          break;

        case DSP_COMPLETE:
          switchPage("complete");
          // complete.t0.txt에 "환자명  총량mL" 표시
          sendToNextion(
            "complete.t0.txt=\"" +
            currentJob.patient_name +
            "  " +
            String(U_volume) +
            "mL" +
            (currentJob.isUrgent ? " [긴급]" : "") +
            "\""
          );          
          // ── 여기에 추가: 다음 대기열 작업 peek 후 표시 ──────────────────
          if (xSemaphoreTake(jobQueueMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
            if (!jobQueue.empty()) {
              Job nextJob = jobQueue.front();  // 꺼내지 않고 peek
              sendToNextion(
                "complete.t2.txt=\"" +
                nextJob.patient_name +
                " " +
                String(nextJob.volume) +
                "mL" +
                (nextJob.isUrgent ? " [긴급]" : "") +
                "\""
              );
            } else {
              // 대기열이 비어 있으면 "없음" 표시
              sendToNextion("complete.t2.txt=\"없음\"");
            }
            xSemaphoreGive(jobQueueMutex);
          }
          //sendToNextion("complete.n0.val=" + String(U_volume));
          dspState = DSP_WAIT_CONFIRM;
          break;
      }
      vTaskDelay(pdMS_TO_TICKS(10));
      
    }
  }
}

// ===== Part 2: 헬퍼 함수, handleClient(), setup(), loop() =====

// ── homing ───────────────────────────────────────────────────
void doHoming() {
  pinMode(LIMIT_PIN, INPUT_PULLUP);
  while (digitalRead(LIMIT_PIN) == HIGH) {
    digitalWrite(EN_PIN, LOW);
    digitalWrite(DIR_PIN, HIGH);
    stepPulse();
  }
  digitalWrite(EN_PIN, HIGH);
  delay(200);
}

// ── 스텝 구동 ───────────────────────────────────────────────
void moveSteps(uint32_t steps, bool forward) {
  digitalWrite(EN_PIN, LOW);
  digitalWrite(DIR_PIN, forward?LOW:HIGH);
  for (uint32_t i=0;i<steps;i++) stepPulse();
  digitalWrite(EN_PIN, HIGH);
}

// ── 펄스 ────────────────────────────────────────────────────
inline void stepPulse() {
  digitalWrite(STEP_PIN, HIGH);
  delayMicroseconds(STEP_US);
  digitalWrite(STEP_PIN, LOW);
  delayMicroseconds(STEP_US);
}

// ── 펌프 제어 ───────────────────────────────────────────────
void runPumpForVolume(int mL) {
  float speed = (mL<=30&&rate30Flag>0?rate30Flag/5.0f:
                 mL<=60&&rate60Flag>0?rate60Flag/5.0f:
                 rate100Flag>0?rate100Flag/5.0f:1.0f);
  uint32_t ms = (uint32_t)((float)mL/speed*1000.0f);
  digitalWrite(PUMP_EN, HIGH);
  digitalWrite(PUMP_PWM, HIGH);
  delay(ms);
  digitalWrite(PUMP_EN, LOW);
  digitalWrite(PUMP_PWM, LOW);
}

// ── EEPROM 유틸 ────────────────────────────────────────────
void saveNetworkCredentials(const String &ssid,const String &pass){
  for(int i=0;i<32;i++){
    EEPROM.write(ADDR_SSID+i,     i<ssid.length()?ssid[i]:0);
    EEPROM.write(ADDR_PASSWORD+i, i<pass.length()?pass[i]:0);
  }
  EEPROM.write(ADDR_FLAG, VALID_FLAG);
  EEPROM.commit();
}
bool loadNetworkCredentials(String &ssid,String &pass){
  if(EEPROM.read(ADDR_FLAG)!=VALID_FLAG) return false;
  char s[33],p[33];
  for(int i=0;i<32;i++){ s[i]=EEPROM.read(ADDR_SSID+i); p[i]=EEPROM.read(ADDR_PASSWORD+i); }
  s[32]=p[32]=0; ssid=String(s); ssid.trim(); pass=String(p); pass.trim();
  return true;
}
void saveFlagsToEEPROM(){
  EEPROM.put(ADDR_VOLUME, volumeFlag);
  EEPROM.put(ADDR_MARGIN, marginFlag);
  EEPROM.put(ADDR_RATE100,rate100Flag);
  EEPROM.put(ADDR_RATE60, rate60Flag);
  EEPROM.put(ADDR_RATE30, rate30Flag);
  EEPROM.commit();
}
void loadFlagsFromEEPROM(){
  EEPROM.get(ADDR_VOLUME, volumeFlag);
  EEPROM.get(ADDR_MARGIN, marginFlag);
  EEPROM.get(ADDR_RATE100,rate100Flag);
  EEPROM.get(ADDR_RATE60, rate60Flag);
  EEPROM.get(ADDR_RATE30, rate30Flag);
}

// ── 헬퍼 ───────────────────────────────────────────────────
String getMacAddressString(){
  uint8_t mac[6]; WiFi.macAddress(mac);
  char buf[18];
  sprintf(buf,"%02X:%02X:%02X:%02X:%02X:%02X",
          mac[0],mac[1],mac[2],mac[3],mac[4],mac[5]);
  return String(buf);
}
void sendToNextion(const String &cmd){
  nextion.print(cmd);
  nextion.write(0xFF); nextion.write(0xFF); nextion.write(0xFF);
}

// ── setup() 위쪽에 추가 ────────────────────────────────────────────────
void connectToWiFi() {
  Serial.println();
  Serial.println("🚀 WiFi 연결 시도: " + selectedSSID);

  WiFi.disconnect(true, true);
  delay(100);
  WiFi.mode(WIFI_STA);
  WiFi.begin(selectedSSID.c_str(), wifiPassword.c_str());

  // 최대 10초 대기
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 10000) {
    vTaskDelay(pdMS_TO_TICKS(500));
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.println("✅ 연결 성공, IP: " + WiFi.localIP().toString());
    // ← 여기에 EEPROM 저장
    saveNetworkCredentials(selectedSSID, wifiPassword);
    Serial.println("💾 SSID·PW를 EEPROM에 저장했습니다");    
    // Nextion에 연결 성공 표시
    sendToNextion("page0.g0.txt=\"Connected to " + selectedSSID + "\"");
    sendToNextion("page0.t8.txt=\"" + WiFi.localIP().toString() + "\"");
    // HTTP 서버 시작
    server.begin();
    Serial.println("▶️ HTTP 서버 시작됨");
  } else {
    Serial.println();
    Serial.println("❌ 연결 실패");
    sendToNextion("page0.g0.txt=\"Connection failed\"");
  }
}

// ── HTTP 요청 처리 ─────────────────────────────────────────
void handleClient(WiFiClient &client){
  String req = client.readStringUntil('\r');
  client.read(); req.trim();
  Serial.println("🌐 요청: "+req);

  if(req.startsWith("GET / ")){
    String body = "{\"status\":\"ready\",\"mac\":\""+getMacAddressString()+
                  "\",\"ip\":\""+WiFi.localIP().toString()+"\"}";
    client.println("HTTP/1.1 200 OK");
    client.println("Content-Type: application/json");
    client.print("Content-Length: "); client.println(body.length());
    client.println("Connection: close");
    client.println(); client.print(body);
    client.stop();
    return;
  }

  // ── GET /version 처리 ─────────────────────────────────────────────────────────
  if (req.startsWith("GET /version")) {
    String body = "{\"version\":\"" + String(FIRMWARE_VERSION) + "\"}";
    client.println("HTTP/1.1 200 OK");
    client.println("Content-Type: application/json");
    client.print("Content-Length: "); client.println(body.length());
    client.println("Connection: close");
    client.println(); client.print(body);
    client.stop();
    Serial.println("📋 버전 정보 요청: " + String(FIRMWARE_VERSION));
    return;
  }

  // ── POST /dispense/triple (PC 앱·3슬롯: 0mL 슬롯은 큐에 넣지 않음, 순차 Job) ──
  if (req.startsWith("POST /dispense/triple")) {
    int contentLength = 0;
    while (client.connected()) {
      String h = client.readStringUntil('\r'); client.read();
      h.trim();
      if (h.length() == 0) break;
      if (h.startsWith("Content-Length:"))
        contentLength = h.substring(15).toInt();
    }
    String body;
    while ((int)body.length() < contentLength) {
      if (client.available()) body += char(client.read());
    }
    Serial.println("📥 POST /dispense/triple: " + body);

    StaticJsonDocument<512> doc;
    DeserializationError err = deserializeJson(doc, body);
    if (!err && doc.containsKey("volume_1") && doc.containsKey("volume_2") && doc.containsKey("volume_3")) {
      int v1 = doc["volume_1"] | 0;
      int v2 = doc["volume_2"] | 0;
      int v3 = doc["volume_3"] | 0;
      if (v1 < 0) v1 = 0;
      if (v2 < 0) v2 = 0;
      if (v3 < 0) v3 = 0;
      if (v1 > 200) v1 = 200;
      if (v2 > 200) v2 = 200;
      if (v3 > 200) v3 = 200;
      String name = doc["label"] | "PC연동";
      bool urgent = doc["urgent"] | false;

      if (v1 == 0 && v2 == 0 && v3 == 0) {
        client.println("HTTP/1.1 400 Bad Request");
        client.println("Content-Type: text/plain");
        client.println("Connection: close");
        client.println();
        client.print("all volumes zero");
        client.stop();
        return;
      }

      xSemaphoreTake(jobQueueMutex, pdMS_TO_TICKS(100));
      if (urgent) {
        std::queue<Job> tempQueue;
        if (v1 > 0) tempQueue.push({v1, marginFlag, name + " 1번", true});
        if (v2 > 0) tempQueue.push({v2, marginFlag, name + " 2번", true});
        if (v3 > 0) tempQueue.push({v3, marginFlag, name + " 3번", true});
        while (!jobQueue.empty()) {
          tempQueue.push(jobQueue.front());
          jobQueue.pop();
        }
        jobQueue = tempQueue;
        Serial.println("🚨 긴급 3슬롯 대기열 맨 앞 추가");
      } else {
        if (v1 > 0) jobQueue.push({v1, marginFlag, name + " 1번", false});
        if (v2 > 0) jobQueue.push({v2, marginFlag, name + " 2번", false});
        if (v3 > 0) jobQueue.push({v3, marginFlag, name + " 3번", false});
      }
      size_t qsize = jobQueue.size();
      xSemaphoreGive(jobQueueMutex);

      sendToNextion("process.n0.val=" + String(qsize));
      updateJobQueueDisplay();
      if (!isProcessing) {
        isProcessing    = true;
        isDispenseReady = true;
      }
      if (isProcessing && dspState == DSP_IDLE) {
        isDispenseReady = true;
      }
      updateJobQueueDisplay();
      String res = (dspState == DSP_IDLE ? "OK" : "BUSY");
      client.println("HTTP/1.1 200 OK");
      client.println("Content-Type: text/plain");
      client.print("Content-Length: "); client.println(res.length());
      client.println("Connection: close");
      client.println(); client.print(res);
      client.stop();
      Serial.println("✅ triple 대기열 추가, 응답: " + res);
      return;
    }

    client.println("HTTP/1.1 400 Bad Request");
    client.println("Content-Type: text/plain");
    client.println("Connection: close");
    client.println();
    client.print("Invalid JSON (need volume_1,2,3)");
    client.stop();
    return;
  }

    // ── POST /dispense (단일 total_volume) ─────────────────────────────────
  if (req.startsWith("POST /dispense") && !req.startsWith("POST /dispense/triple")) {
      int contentLength = 0;
      while (client.connected()) {
          String h = client.readStringUntil('\r'); client.read();
          h.trim();
          if (h.length() == 0) break;
          if (h.startsWith("Content-Length:"))
              contentLength = h.substring(15).toInt();
      }
      String body;
      while ((int)body.length() < contentLength) {
          if (client.available()) body += char(client.read());
      }
      Serial.println("📥 JSON: " + body);

      StaticJsonDocument<256> doc;
      DeserializationError err = deserializeJson(doc, body);
      if (!err && doc.containsKey("total_volume")) {
          int vol = doc["total_volume"];
          String name = doc["patient_name"] | "Unknown";
          bool urgent = doc["urgent"] | false;  // 긴급 플래그 추가
          Serial.println("📥 환자: " + name + ", vol=" + String(vol) + ", urgent=" + String(urgent));

          // 1) 큐에 추가 (긴급 작업은 맨 앞에 추가)
          xSemaphoreTake(jobQueueMutex, pdMS_TO_TICKS(100));
          
          if (urgent) {
            // 긴급 작업: 기존 큐를 임시로 복사하고, 긴급 작업을 맨 앞에 넣은 후 다시 복사
            std::queue<Job> tempQueue;
            tempQueue.push({vol, marginFlag, name, true});  // 긴급 작업을 맨 앞에
            
            // 기존 작업들을 그 뒤에 추가
            while (!jobQueue.empty()) {
              tempQueue.push(jobQueue.front());
              jobQueue.pop();
            }
            
            // 임시 큐를 원래 큐로 복사
            jobQueue = tempQueue;
            Serial.println("🚨 긴급 작업이 대기열 맨 앞에 추가됨");
          } else {
            // 일반 작업: 맨 뒤에 추가
            jobQueue.push({vol, marginFlag, name, false});
          }
          
          size_t qsize = jobQueue.size();
          xSemaphoreGive(jobQueueMutex);

          // 2) PROCESS 화면 및 대기열 업데이트
          //switchPage("process");
          sendToNextion("process.n0.val=" + String(qsize));
          updateJobQueueDisplay();
          // ★ 추가: 현재 분주 중이 아니면(=키패드에 있을 때) 자동으로 첫 작업 시작
          if (!isProcessing) {
            isProcessing    = true;
            isDispenseReady = true;
            //switchPage("process");
          }
          if (isProcessing && dspState == DSP_IDLE) {
            isDispenseReady = true;
            //switchPage("process");
          }          
          // 3) 유휴 상태면 즉시 시작
          //if (dspState == DSP_IDLE) {
              //isDispenseReady = true;
          //}
          updateJobQueueDisplay();
          // 4) 응답
          String res = (dspState == DSP_IDLE ? "OK" : "BUSY");
          client.println("HTTP/1.1 200 OK");
          client.println("Content-Type: text/plain");
          client.print("Content-Length: "); client.println(res.length());
          client.println("Connection: close");
          client.println(); client.print(res);
          client.stop();

          Serial.println("✅ 대기열 추가됨, 응답: " + res);
          return;
      }

      // 잘못된 JSON (헤더 끝에 빈 줄 필수 — 없으면 PC 클라이언트가 본문을 못 읽음)
      client.println("HTTP/1.1 400 Bad Request");
      client.println("Content-Type: text/plain");
      client.println("Connection: close");
      client.println("Content-Length: 12");
      client.println();
      client.print("Invalid JSON");
      client.stop();
      return;
  }

    String nf="404 Not Found";
    client.println("HTTP/1.1 404 Not Found");
    client.println("Content-Type: text/plain");
    client.print("Content-Length: "); client.println(nf.length());
    client.println("Connection: close");
    client.println(); client.print(nf);
    client.stop();
  }

// ── setup() ────────────────────────────────────────────────────────────────
void setup(){
  Serial.begin(115200); delay(1000);
  Serial.println("🚀 ESP32 부팅");
  Wire.begin();  // I2C (로드셀 연결 검사용)
  // TMC2209 init
  pinMode(EN_PIN,OUTPUT); digitalWrite(EN_PIN,HIGH);
  pinMode(DIR_PIN,OUTPUT); pinMode(STEP_PIN,OUTPUT);
  pinMode(PUMP_EN,OUTPUT); pinMode(PUMP_PWM,OUTPUT);
  digitalWrite(PUMP_EN,LOW); digitalWrite(PUMP_PWM,LOW);
  pinMode(SENSOR_D0_PIN,INPUT_PULLUP);
  TMCserial.begin(115200,SERIAL_8N1,UART_TX);
  driver.begin();
  driver.rms_current(1200,0.0);
  driver.microsteps(1);
  driver.en_spreadCycle(false);
  driver.TPOWERDOWN(10);
  nextion.begin(9600,SERIAL_8N1,NEXTION_RX,NEXTION_TX);
  EEPROM.begin(512); delay(500);
  loadFlagsFromEEPROM();
  U_volume=volumeFlag; S_offset=marginFlag;
  rate_mL_per_sec=(rateFlag>0)?(float)rateFlag/5.0f:1.0f;
  sendToNextion("setting.n0.val="+String(rate100Flag));
  sendToNextion("setting.n1.val="+String(marginFlag));
  sendToNextion("setting.n2.val="+String(rate60Flag));
  sendToNextion("setting.n3.val="+String(rate30Flag));

  String ss,sq;
  if(loadNetworkCredentials(ss,sq)){
    selectedSSID=ss; wifiPassword=sq;
    Serial.println("📶 SSID:"+selectedSSID);
    Serial.println("🔐 PW:"+wifiPassword);
    WiFi.disconnect(true,true);
    delay(100);
    WiFi.mode(WIFI_STA);
    WiFi.begin(selectedSSID.c_str(),wifiPassword.c_str());
    unsigned long t0=millis();
    while(WiFi.status()!=WL_CONNECTED && millis()-t0<10000){
      delay(500); Serial.print(".");
    }
    Serial.println();
    if(WiFi.status()==WL_CONNECTED){
      Serial.println("✅ 연결:"+selectedSSID);
      Serial.println("🌐 IP:"+WiFi.localIP().toString());
      sendToNextion("page0.g0.txt=\"Connected to "+selectedSSID+"\"");
      sendToNextion("page0.t8.txt=\""+WiFi.localIP().toString()+"\"");
      server.begin();
    } else {
      Serial.println("❌ WiFi 실패");
      sendToNextion("page0.g0.txt=\"Connection failed\"");
      WiFi.disconnect(true,true);
      WiFi.mode(WIFI_OFF);
      delay(100);
      WiFi.mode(WIFI_STA);
    }
  } else {
    Serial.println("📭 WiFi 정보 없음");
  }
  scanWiFi();
  // FreeRTOS 태스크 생성
  jobQueueMutex = xSemaphoreCreateMutex();

  xTaskCreatePinnedToCore(
    dispenseTask,
    "DispenseTask",
    8192,
    NULL,
    1,
    &dispenseTaskHandle,
    1
  );

  xTaskCreatePinnedToCore(
    httpServerTask,
    "HTTPServerTask",
    8192,
    NULL,
    2,
    &httpTaskHandle,
    0
  );

  xTaskCreatePinnedToCore(
    hmiTask,
    "HMITask",
    4096,
    NULL,
    1,
    &hmiTaskHandle,
    1
  );

  xTaskCreatePinnedToCore(
    scaleTask,
    "ScaleTask",
    4096,
    NULL,
    1,
    &scaleTaskHandle,
    0
  );

  switchPage("confirm");
}

// ── loop() ────────────────────────────────────────────────────────────────
void loop(){
  static unsigned long lastHMIUpdate = 0;
  if (millis() - lastHMIUpdate >= 500) {
    lastHMIUpdate = millis();
    if (xSemaphoreTake(jobQueueMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
      sendToNextion("process.n0.val=" + String(jobQueue.size()));
      updateJobQueueDisplay();
      xSemaphoreGive(jobQueueMutex);
    }
  }
  delay(10);
} 