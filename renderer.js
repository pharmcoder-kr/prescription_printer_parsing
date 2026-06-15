const { ipcRenderer } = require('electron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const cron = require('node-cron');
const iconv = require('iconv-lite');
const { extractReceiptNumberFromPdfPath } = require('./src/pdfBagParser');

// 전역 변수
let savedConnections = {};
let connectedDevices = {};
let availableNetworks = [];
let prescriptionPath = '';
let parsedFiles = new Set();
let parsedPrescriptions = {};
let autoDispensing = false;
let scanInterval = null;
let connectionCheckInterval = null;
let backgroundScanActive = false; // 백그라운드 스캔 상태 추가
let isCheckingStatus = false; // 연결 상태 확인 중복 실행 방지
let autoReconnectAttempted = new Map(); // 자동 재연결 시도한 기기들 (시도 횟수 포함)
let manuallyDisconnectedDevices = new Set(); // 수동으로 연결을 끊은 기기들
let networkPrefix = null; // 현재 네트워크 프리픽스
let networkInfoMap = new Map(); // 네트워크 프리픽스 -> 네트워크 정보 매핑
let transmissionStatus = {}; // 각 환자의 전송상태 저장 (receiptNumber -> count)
let maxSyrupAmount = 100; // 시럽 최대량 (기본값: 100mL)
let medicineTransmissionStatus = {}; // 각 약물의 전송상태 저장 (receiptNumber_medicineCode -> count)
let connectionCheckDelayTimer = null; // 연결 상태 확인 지연 타이머
let isDispensingInProgress = false; // 조제 진행 중 플래그
let dispensingDevices = new Set(); // 조제 중인 기기들의 IP 주소 집합
let isAutoDispensingInProgress = false; // 자동조제 진행 중 플래그 (중복 실행 방지)
let autoDispensingQueue = []; // 자동조제 대기열 (처방전 접수번호 배열)
let connectionCheckIntervalMs = 15000; // 연결 상태 확인 주기 (기본값: 15초)
let prescriptionProgram = 'pm3000'; // 처방조제프로그램 (기본값: PM3000)
let prescriptionParseMode = 'emr_file'; // 처방연동 방식 (emr_file | pdf_bag)
let sentParseEvents = new Set(); // 이미 전송한 파싱 이벤트 (중복 방지)
let pharmacyStatus = null; // 약국 승인 상태 (null, 'pending', 'active', 'rejected')
let loginMode = null; // 로그인 모드 ('logged_in', 'no_login', null)
let parseEnabled = false; // 파싱 기능 활성화 여부

// ============================================
// 약국 승인 상태 확인
// ============================================

/**
 * 약국 승인 상태 확인 및 업데이트
 * ⚠️ 주의: 이 함수는 서버와 통신하지 않고, 로컬 토큰과 상태 파일만 확인합니다.
 * 서버 검증은 main.js의 verifyTokenInBackground()에서 백그라운드로 수행됩니다.
 */
async function checkAndUpdatePharmacyStatus() {
    console.log('[상태 확인] 약국 상태 확인 시작... (로컬만 확인, 서버 통신 안 함)');
    try {
        // 로컬 토큰 존재 여부만 확인 (서버 검증 안 함)
        const isEnrolled = await ipcRenderer.invoke('auth:is-enrolled');
        
        if (!isEnrolled) {
            pharmacyStatus = null;
            logMessage('⚠️ 약국이 등록되지 않았습니다.');
            return;
        }
        
        // 로그인 정보 확인 (로컬에서만)
        const loginStatus = await ipcRenderer.invoke('auth:get-token');
        if (!loginStatus) {
            pharmacyStatus = null;
            return;
        }
        
        // 상태 파일 읽기 (로컬 파일 시스템)
        const userDataPath = await ipcRenderer.invoke('get-user-data-path');
        const statusFilePath = path.join(userDataPath, 'pharmacy-status.txt');
        
        if (fs.existsSync(statusFilePath)) {
            pharmacyStatus = fs.readFileSync(statusFilePath, 'utf8').trim();
            console.log(`[상태 확인] pharmacyStatus 설정됨: ${pharmacyStatus}`);
            
            if (pharmacyStatus === 'pending') {
                logMessage('⚠️ 약국 승인 대기 중입니다. 관리자 승인 후 처방전연동 기능이 활성화됩니다.');
            } else if (pharmacyStatus === 'active') {
                logMessage('✅ 약국 승인 완료 - 모든 기능 사용 가능');
            } else if (pharmacyStatus === 'rejected') {
                logMessage('❌ 약국 등록이 거부되었습니다.');
            }
        } else {
            pharmacyStatus = null;
            console.log('[상태 확인] pharmacy-status.txt 파일 없음 - pharmacyStatus = null');
        }
    } catch (error) {
        console.error('약국 상태 확인 중 오류:', error);
        pharmacyStatus = null;
    }
}

/**
 * 상태 수동 새로고침 (개발자 도구에서 사용)
 */
async function refreshPharmacyStatus() {
    const previousStatus = pharmacyStatus;
    console.log('[수동 새로고침] 이전 상태:', previousStatus);
    
    await checkAndUpdatePharmacyStatus();
    
    console.log('[수동 새로고침] 새 상태:', pharmacyStatus);
    
    // 상태가 변경되었고 승인되었다면 처방전연동 시작
    if (previousStatus === 'pending' && pharmacyStatus === 'active') {
        logMessage('🎉 약국이 승인되었습니다! 처방전연동 기능이 활성화됩니다.');
        parseAllPrescriptionFiles();
    }
    
    return pharmacyStatus;
}

// 글로벌로 노출 (개발자 도구에서 사용 가능)
window.refreshPharmacyStatus = refreshPharmacyStatus;
window.parseAllPrescriptionFiles = parseAllPrescriptionFiles;
window.toggleLogPanel = toggleLogPanel;
window.sendAllPendingEvents = sendAllPendingEvents; // 수동 전송 기능
window.getNewFileCount = () => newFileParseCount; // 새 파일 개수 확인
window.resetNewFileCount = () => { newFileParseCount = 0; }; // 카운터 초기화
window.testSaveLog = saveLogToFile; // 테스트용

// ============================================
// 파싱 이벤트 전송 (사용량 집계용)
// ============================================

// 앱 종료 시 전송을 위한 카운터
let newFileParseCount = 0; // 새로 파싱된 파일 개수 (로그인 이후에만 카운트)
let isLoggedInSession = false; // 로그인 세션 플래그 (로그인 이후에만 true)

// parsedFiles를 로컬에 저장/불러오기
let parsedFilesPath = '';

async function getParsedFilesPath() {
    if (!parsedFilesPath) {
        const userData = await getUserDataPath();
        parsedFilesPath = path.join(userData, 'parsed-files.json');
    }
    return parsedFilesPath;
}

/**
 * parsedFiles를 로컬 파일에 저장
 */
async function saveParsedFiles() {
    try {
        const filePath = await getParsedFilesPath();
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify([...parsedFiles]), 'utf8');
    } catch (error) {
        console.error('parsedFiles 저장 중 오류:', error);
    }
}

/**
 * parsedFiles를 로컬 파일에서 불러오기
 */
async function loadParsedFiles() {
    try {
        const filePath = await getParsedFilesPath();
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            const files = JSON.parse(data);
            parsedFiles = new Set(files);
            logMessage(`✅ parsedFiles 불러오기 완료: ${parsedFiles.size}개 파일`);
            console.log(`✅ parsedFiles 불러오기 완료: ${parsedFiles.size}개 파일`);
        } else {
            logMessage('ℹ️ parsedFiles 파일이 없습니다. 새로 시작합니다.');
            console.log('ℹ️ parsedFiles 파일이 없습니다. 새로 시작합니다.');
        }
    } catch (error) {
        logMessage(`❌ parsedFiles 불러오기 중 오류: ${error.message}`);
        console.error('parsedFiles 불러오기 중 오류:', error);
        parsedFiles = new Set();
    }
}

/**
 * 파일이 오늘 생성된 파일인지 확인
 * @param {string} filePath - 파일 경로
 * @returns {boolean} 오늘 생성된 파일이면 true
 */
function isFileCreatedToday(filePath) {
    try {
        const stats = fs.statSync(filePath);
        const fileCreationTime = new Date(stats.birthtime);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const isToday = fileCreationTime >= today;
        console.log(`파일 생성 시간 확인: ${path.basename(filePath)} - 생성시간: ${fileCreationTime.toLocaleString()}, 오늘: ${isToday}`);
        
        return isToday;
    } catch (error) {
        console.error(`파일 생성 시간 확인 실패: ${path.basename(filePath)} - ${error.message}`);
        return false;
    }
}

// queueParseEvent 함수는 더 이상 사용하지 않음 (카운터 방식으로 변경)
function queueParseEvent(filePath) {
    // 아무 작업도 하지 않음 (카운터는 startPrescriptionMonitor에서 직접 증가)
}

/**
 * 디바이스 UID를 동기 방식으로 읽기
 */
function getDeviceUidSync() {
    try {
        const deviceUidPath = path.join(require('os').homedir(), 'AppData', 'Roaming', 'auto-syrup', 'device-uid.txt');
        if (fs.existsSync(deviceUidPath)) {
            return fs.readFileSync(deviceUidPath, 'utf8').trim();
        }
    } catch (error) {
        console.error('디바이스 UID 읽기 실패:', error);
    }
    return 'unknown-device';
}

/**
 * 한국 시간대(KST, UTC+9)로 ISO 문자열 생성
 * @returns {string} 한국 시간대 ISO 문자열 (예: 2025-11-19T10:39:23.427+09:00)
 */
function getKSTISOString() {
    const now = new Date();
    // 한국 시간대는 UTC+9
    const kstOffset = 9 * 60; // 분 단위
    const kstTime = new Date(now.getTime() + (kstOffset * 60 * 1000));
    
    // ISO 문자열 생성 후 시간대를 +09:00으로 변경
    const isoString = kstTime.toISOString();
    return isoString.replace('Z', '+09:00');
}


/**
 * 앱 종료 시 모든 이벤트 전송
 */
async function sendAllPendingEvents() {
    try {
        console.log('[RENDERER] Starting sendAllPendingEvents...');
        console.log('[RENDERER] New file count:', newFileParseCount);
        
        if (newFileParseCount === 0) {
            console.log('[RENDERER] No new files to send');
            return;
        }
        
        console.log('[RENDERER] Sending', newFileParseCount, 'parse events...');
        
        const deviceUid = getDeviceUidSync();
        console.log('[RENDERER] Device UID:', deviceUid);
        
        const events = [];
        
        // newFileParseCount만큼 이벤트 생성
        for (let i = 0; i < newFileParseCount; i++) {
            events.push({
                source: 'pharmIT3000',
                count: 1,
                idempotency_key: `${deviceUid}_batch_${Date.now()}_${i}`,
                ts: getKSTISOString(), // 한국 시간대 사용
                filePath: `batch_${i}` // 더미 경로
            });
        }
        
        console.log('[RENDERER] Created', events.length, 'events');
        
        // IPC를 통해 메인 프로세스로 배치 전송
        console.log('[RENDERER] Sending via IPC...');
        const result = await ipcRenderer.invoke('api:send-batch-parse-events', events);
        
        console.log('[RENDERER] IPC result:', result);
        
        if (result && result.success) {
            console.log('[RENDERER] Events sent successfully:', newFileParseCount, 'events');
            newFileParseCount = 0; // 카운터 초기화
        } else {
            console.error('[RENDERER] Event send failed:', result ? result.error : 'No result');
        }
    } catch (error) {
        console.error('[RENDERER] Error in sendAllPendingEvents:', error.message);
        console.error('[RENDERER] Error stack:', error.stack);
    }
}

/**
 * 처방전 파싱 이벤트를 서버로 전송 (즉시 전송 - 레거시)
 * @param {string} filePath - 파싱한 파일 경로
 */
async function sendParseEvent(filePath) {
    try {
        // 중복 키 생성 (device_uid + 파일경로 + 수정시간)
        const stats = fs.statSync(filePath);
        const mtime = stats.mtimeMs;
        const deviceUid = await getDeviceUid(); // device-uid.txt에서 읽기
        
        const idempotencyKey = `${deviceUid}_${filePath}_${mtime}`;
        
        // 이미 전송한 이벤트인지 확인
        if (sentParseEvents.has(idempotencyKey)) {
            return;
        }
        
        const eventData = {
            source: 'pharmIT3000',
            count: 1,
            idempotency_key: idempotencyKey,
            ts: getKSTISOString() // 한국 시간대 사용
        };
        
        // IPC를 통해 메인 프로세스로 전송
        const result = await ipcRenderer.invoke('api:send-parse-event', eventData);
        
        if (result.success) {
            sentParseEvents.add(idempotencyKey);
            console.log('✅ 처방전연동 이벤트 전송 성공:', path.basename(filePath));
        } else {
            // 로그인 정보가 없는 경우는 로그만 남기고 진행
            if (result.error === 'no_credentials' || result.error === 'no_token') {
                console.log('⚠️ 로그인이 필요합니다. 처방전연동 이벤트가 전송되지 않습니다.');
            } else if (result.error && result.error.includes('승인')) {
                console.log('⚠️ 약국 승인 대기 중입니다. 승인 후 처방전연동 이벤트가 전송됩니다.');
            } else {
                console.warn('⚠️ 처방전연동 이벤트 전송 실패:', result.error);
            }
        }
    } catch (error) {
        // 에러가 발생해도 앱 사용에는 지장 없음
        console.error('❌ 처방전연동 이벤트 전송 중 오류:', error);
    }
}

/**
 * device-uid.txt에서 디바이스 UID 읽기
 */
async function getDeviceUid() {
    try {
        const userDataPath = await ipcRenderer.invoke('get-user-data-path');
        const deviceUidPath = path.join(userDataPath, 'device-uid.txt');
        
        if (fs.existsSync(deviceUidPath)) {
            return fs.readFileSync(deviceUidPath, 'utf8').trim();
        }
    } catch (error) {
        console.error('device UID 읽기 실패:', error);
    }
    return 'unknown';
}

// 전송 상태 헬퍼 함수들
function getStatusText(status) {
    if (status === '등록되지 않은 약물') return '등록되지 않은 약물';
    if (status === '최대량 초과') return '최대량 초과';
    if (typeof status === 'number') {
        if (status === 0 || !isFinite(status)) return '0'; // -Infinity, Infinity, NaN 처리
        return status.toString();
    }
    return '0'; // 기본값
}

function getStatusBadgeClass(status) {
    if (status === '등록되지 않은 약물') return 'bg-dark';
    if (status === '최대량 초과') return 'bg-warning';
    if (typeof status === 'number') {
        if (status === 0 || !isFinite(status)) return 'bg-secondary'; // -Infinity, Infinity, NaN 처리
        return 'bg-success';
    }
    return 'bg-secondary';
}

function isSuccessStatus(status) {
    if (status === '등록되지 않은 약물') return false;
    if (typeof status === 'number') {
        return status > 0 && isFinite(status); // -Infinity, Infinity, NaN 처리
    }
    return false;
}

function incrementTransmissionCount(currentStatus) {
    if (currentStatus === '등록되지 않은 약물') return '등록되지 않은 약물';
    if (typeof currentStatus === 'number') {
        return currentStatus + 1;
    }
    return 1; // 처음 전송
}

// 수동조제 전송현황 리스트 관리
let manualStatusList = [];

function addManualStatus({ syrupName, total }) {
    const now = moment().format('HH:mm:ss');
    const entry = {
        time: now,
        syrupName,
        total,
        status: '전송중',
        statusClass: 'manual-status-sending',
        id: Date.now() + Math.random()
    };
    manualStatusList.unshift(entry); // 최근순
    if (manualStatusList.length > 10) manualStatusList = manualStatusList.slice(0, 10);
    renderManualStatusList();
    return entry.id;
}

function updateManualStatus(id, status) {
    const entry = manualStatusList.find(e => e.id === id);
    if (!entry) return;
    if (status === '완료') {
        entry.status = '완료';
        entry.statusClass = 'manual-status-success';
    } else if (status === '실패') {
        entry.status = '실패';
        entry.statusClass = 'manual-status-fail';
    }
    renderManualStatusList();
}

function renderManualStatusList() {
    const tbody = document.getElementById('manualStatusListBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    manualStatusList.forEach(entry => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${entry.time}</td>
            <td>${entry.syrupName}</td>
            <td>${entry.total}</td>
            <td class="${entry.statusClass}">${entry.status}</td>
        `;
        tbody.appendChild(tr);
    });
    // 빈 줄 추가 (10줄 고정)
    for (let i = manualStatusList.length; i < 10; i++) {
        const tr = document.createElement('tr');
        tr.className = 'empty-row';
        tr.innerHTML = '<td>&nbsp;</td><td></td><td></td><td></td>';
        tbody.appendChild(tr);
    }
}

// DOM 요소들
const elements = {
    mainPage: document.getElementById('mainPage'),
    networkPage: document.getElementById('networkPage'),
    pathEntry: document.getElementById('pathEntry'),
    datePicker: document.getElementById('datePicker'),
    patientTableBody: document.getElementById('patientTableBody'),
    medicineTableBody: document.getElementById('medicineTableBody'),
    logContainer: document.getElementById('logContainer'),
    logPanelRow: document.getElementById('logPanelRow'),
    networkTableBody: document.getElementById('networkTableBody'),
    savedList: document.getElementById('savedList'),
    connectedTableBody: document.getElementById('connectedTableBody'),
    autoDispensing: document.getElementById('autoDispensing'),
    maxSyrupAmount: document.getElementById('maxSyrupAmount')
};

// 초기화
document.addEventListener('DOMContentLoaded', async () => {
    await initializeApp();
    setupEventListeners();
    setupDatePicker();
    await loadConnections();
    await loadPrescriptionPath();
    await loadTransmissionStatus(); // 전송상태 로드 추가
    await loadMedicineTransmissionStatus(); // 약물별 전송상태 로드 추가
    await loadAutoDispensingSettings();
    await loadPrescriptionProgramSettings(); // 처방조제프로그램 설정 로드 추가
    await loadPdfBagTemplate();
    startPeriodicTasks();
    // datePicker 값이 비어있으면 오늘 날짜로 세팅
    if (!elements.datePicker.value) {
        const today = moment().format('YYYY-MM-DD');
        elements.datePicker.value = today;
    }
    // 초기 로드 시 자동조제 화면의 연결된 기기 상태 업데이트
    updateMainPageConnectedDevices();
});

// 로그를 파일로 저장하는 함수
function saveLogToFile() {
    try {
        console.log('[RENDERER] Starting log file save...');
        
        const logElement = document.getElementById('log');
        if (!logElement) {
            console.error('[RENDERER] Log element not found');
            return null;
        }
        
        const logContent = logElement.textContent;
        console.log('[RENDERER] Log content length:', logContent.length);
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logFileName = `app-log-${timestamp}.txt`;
        
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        
        // AppData 폴더에 저장
        const appDataPath = path.join(os.homedir(), 'AppData', 'Roaming', 'auto-syrup');
        console.log('[RENDERER] AppData path:', appDataPath);
        
        if (!fs.existsSync(appDataPath)) {
            console.log('[RENDERER] Creating AppData directory...');
            fs.mkdirSync(appDataPath, { recursive: true });
        }
        
        const logPath = path.join(appDataPath, logFileName);
        console.log('[RENDERER] Writing log file to:', logPath);
        
        fs.writeFileSync(logPath, logContent, 'utf8');
        
        console.log('[RENDERER] Log file saved successfully:', logPath);
        return logPath;
    } catch (error) {
        console.error('[RENDERER] Failed to save log file:', error.message);
        console.error('[RENDERER] Error stack:', error.stack);
        return null;
    }
}

// 앱 종료 시 남은 이벤트 전송 및 로그 저장
// beforeunload는 main.js의 before-quit에서 처리
// window.addEventListener('beforeunload', ...) 제거

// 로그인 상태 업데이트
async function updateLoginStatus(data) {
    if (data && data.mode === 'no_login') {
        loginMode = 'no_login';
        parseEnabled = false;
        isLoggedInSession = false; // 비로그인 모드에서는 로그인 세션 플래그 false
        newFileParseCount = 0; // 비로그인 모드로 전환 시 카운터 초기화
        logMessage('⚠️ 비로그인 모드: 처방전연동 기능이 비활성화되었습니다. 수동 전송만 가능합니다.');
        
        // 비로그인 모드일 때 기존 데이터 초기화
        parsedFiles = new Set();
        parsedPrescriptions = {};
        initializeEmptyTables();
        
        // 수동조제 화면으로 전환
        showManualPage();
        
        // 메인 버튼 비활성화
        const mainButton = document.querySelector('button[onclick="showMainPage()"]');
        if (mainButton) {
            mainButton.disabled = true;
            mainButton.classList.add('disabled');
            mainButton.style.opacity = '0.5';
            mainButton.style.cursor = 'not-allowed';
        }
    } else {
        // 로그인 모드 확인
        const loginStatus = await ipcRenderer.invoke('auth:get-token');
        if (loginStatus) {
            loginMode = 'logged_in';
            
            // 로그인 성공 시 파싱 카운터 초기화 (로그인 이후 파싱된 파일만 카운트)
            const previousLoginState = isLoggedInSession;
            isLoggedInSession = true;
            if (!previousLoginState) {
                // 새로 로그인한 경우 카운터 초기화
                newFileParseCount = 0;
                console.log('[AUTH] 로그인 완료 - 파싱 카운터 초기화');
                logMessage('✅ 로그인 완료: 로그인 이후 파싱된 파일만 카운트됩니다.');
            }
            
            // 약국 상태 확인하여 파싱 기능 활성화 여부 결정
            await checkAndUpdatePharmacyStatus();
            // 과금 상태는 서버에서 확인해야 하므로, 일단 pharmacyStatus가 'active'면 활성화
            parseEnabled = (pharmacyStatus === 'active');
            if (parseEnabled && prescriptionPath) {
                logMessage('✅ 로그인 완료: 처방전연동 기능이 활성화되었습니다.');
                await parseAllPrescriptionFiles();
                startPrescriptionMonitor();
            } else if (parseEnabled) {
                logMessage('✅ 로그인 완료: 처방전연동 기능이 활성화되었습니다. (처방 경로 로드 후 파싱)');
            } else {
                logMessage('⚠️ 로그인 완료: 과금 상태를 확인 중입니다. 처방전연동 기능이 제한될 수 있습니다.');
            }
            
            // 메인 버튼 활성화
            const mainButton = document.querySelector('button[onclick="showMainPage()"]');
            if (mainButton) {
                mainButton.disabled = false;
                mainButton.classList.remove('disabled');
                mainButton.style.opacity = '1';
                mainButton.style.cursor = 'pointer';
            }
        } else {
            loginMode = null;
            parseEnabled = false;
            isLoggedInSession = false; // 로그아웃 상태로 설정
        }
    }
}

// 로그인 상태 변경 이벤트 리스너
ipcRenderer.on('auth:login-status-changed', async (event, data) => {
    console.log('[AUTH] Login status changed:', data);
    await updateLoginStatus(data);
});

// 앱 초기화
async function initializeApp() {
    logMessage('시럽조제기 연결 관리자가 시작되었습니다.');
    
    // 로그인 상태 확인
    await updateLoginStatus();
    
    // 약국 승인 상태 확인
    await checkAndUpdatePharmacyStatus();
    
    // 비로그인 모드가 아니면 parsedFiles 불러오기 (프로그램 시작 시)
    if (loginMode !== 'no_login') {
        await loadParsedFiles();
    } else {
        // 비로그인 모드일 때는 데이터를 불러오지 않음
        parsedFiles = new Set();
        parsedPrescriptions = {};
        logMessage('ℹ️ 비로그인 모드: 기존 데이터를 불러오지 않습니다.');
    }
    
    await loadPrescriptionPath();
    await loadConnections(); // 저장된 연결 정보 로드
    await loadTransmissionStatus(); // 전송상태 로드 추가
    await loadMedicineTransmissionStatus(); // 약물별 전송상태 로드 추가
    await loadPrescriptionProgramSettings(); // 처방조제프로그램 설정 로드 추가
    await loadPdfBagTemplate();
    logMessage(`로드된 처방전 경로: ${prescriptionPath}`);
    initializeEmptyTables();
    
    // 약국 상태 주기적 확인 (5분마다)
    setInterval(async () => {
        const previousStatus = pharmacyStatus;
        await checkAndUpdatePharmacyStatus();
        
        // 로그인 모드가 아니면 파싱 기능 비활성화
        if (loginMode !== 'logged_in') {
            parseEnabled = false;
        } else {
            // 로그인 모드면 약국 상태에 따라 파싱 기능 활성화
            parseEnabled = (pharmacyStatus === 'active');
        }
        
        // 상태가 변경되었고 승인되었다면 처방전연동 시작
        if (previousStatus === 'pending' && pharmacyStatus === 'active' && parseEnabled) {
            logMessage('🎉 약국이 승인되었습니다! 처방전연동 기능이 활성화됩니다.');
            parseAllPrescriptionFiles();
        }
    }, 5 * 60 * 1000); // 5분마다
    detectNetworks();
    // 프로그램 시작 시 기존 파일들 처방전연동 (리스트 표시용, 이벤트 전송 제외)
    await parseAllPrescriptionFiles();
    startPrescriptionMonitor();
    
    // 저장된 기기들 즉시 연결 시도
    attemptInitialConnection();
    
    startPeriodicTasks(); // 주기적 작업 시작 (자동 연결 포함)
    
    // 비로그인 모드일 때 첫 화면을 수동조제로 설정
    if (loginMode === 'no_login') {
        showManualPage();
        // 메인 버튼 비활성화
        const mainButton = document.querySelector('button[onclick="showMainPage()"]');
        if (mainButton) {
            mainButton.disabled = true;
            mainButton.classList.add('disabled');
            mainButton.style.opacity = '0.5';
            mainButton.style.cursor = 'not-allowed';
        }
    }

    // datePicker 값이 비어있으면 오늘 날짜로 세팅
    if (!elements.datePicker.value) {
        const today = moment().format('YYYY-MM-DD');
        elements.datePicker.value = today;
    }
}

// 초기 빈 테이블 설정
function initializeEmptyTables() {
    // 환자 정보 테이블에 빈 행 추가
    elements.patientTableBody.innerHTML = '';
    for (let i = 0; i < 5; i++) {
        const emptyRow = document.createElement('tr');
        emptyRow.innerHTML = `
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
        `;
        emptyRow.classList.add('empty-row');
        elements.patientTableBody.appendChild(emptyRow);
    }
    
    // 약물 정보 테이블에 빈 행 추가
    elements.medicineTableBody.innerHTML = '';
    for (let i = 0; i < 5; i++) {
        const emptyRow = document.createElement('tr');
        emptyRow.innerHTML = `
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
        `;
        emptyRow.classList.add('empty-row');
        elements.medicineTableBody.appendChild(emptyRow);
    }
}

function toggleLogPanel() {
    const row = elements.logPanelRow;
    if (!row) return;
    row.classList.toggle('d-none');
    if (!row.classList.contains('d-none')) {
        if (elements.logContainer) {
            elements.logContainer.scrollTop = elements.logContainer.scrollHeight;
        }
    }
}

// 이벤트 리스너 설정
function setupEventListeners() {
    window.addEventListener('keydown', (event) => {
        if (event.key === 'F12') {
            event.preventDefault();
            startDispensing();
            return;
        }
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyL') {
            event.preventDefault();
            toggleLogPanel();
        }
    }, true);

    // 네트워크 테이블 행 클릭 이벤트
    elements.networkTableBody.addEventListener('click', (e) => {
        const row = e.target.closest('tr');
        if (row) {
            // 기존 선택 해제
            document.querySelectorAll('#networkTableBody tr').forEach(r => r.classList.remove('selected'));
            // 새 행 선택
            row.classList.add('selected');
        }
    });
    
    // 저장된 연결 목록 클릭 이벤트
    elements.savedList.addEventListener('click', (e) => {
        const item = e.target.closest('.list-group-item');
        if (item) {
            // 기존 선택 해제
            document.querySelectorAll('#savedList .list-group-item').forEach(i => i.classList.remove('active'));
            // 새 아이템 선택
            item.classList.add('active');
        }
    });
    
    // 연결된 기기 테이블 행 클릭 이벤트
    elements.connectedTableBody.addEventListener('click', (e) => {
        const row = e.target.closest('tr');
        if (row) {
            // 기존 선택 해제
            document.querySelectorAll('#connectedTableBody tr').forEach(r => r.classList.remove('selected'));
            // 새 행 선택
            row.classList.add('selected');
        }
    });

    // 자동 조제 체크박스 이벤트
    elements.autoDispensing.addEventListener('change', async (e) => {
        autoDispensing = e.target.checked;
        await saveAutoDispensingSettings();
        logMessage(`자동 조제 ${autoDispensing ? '활성화' : '비활성화'}`);
    });

    // 시럽 최대량 설정 이벤트
    elements.maxSyrupAmount.addEventListener('change', async (e) => {
        maxSyrupAmount = parseInt(e.target.value) || 100;
        await saveAutoDispensingSettings();
        logMessage(`시럽 최대량 설정 변경: ${maxSyrupAmount}mL`);
    });
    
    elements.maxSyrupAmount.addEventListener('blur', async (e) => {
        maxSyrupAmount = parseInt(e.target.value) || 100;
        await saveAutoDispensingSettings();
        logMessage(`시럽 최대량 설정 변경: ${maxSyrupAmount}mL`);
    });

    // 환자 테이블 클릭 이벤트
    elements.patientTableBody.addEventListener('click', (event) => {
        const row = event.target.closest('tr');
        if (row) {
            // 기존 선택 해제
            document.querySelectorAll('#patientTableBody tr').forEach(r => r.classList.remove('table-primary'));
            // 현재 행 선택
            row.classList.add('table-primary');
            loadPatientMedicines(row.dataset.receiptNumber);
        }
    });

    // 약물 테이블 체크박스 이벤트
    elements.medicineTableBody.addEventListener('change', (event) => {
        if (event.target.type === 'checkbox') {
            updateMedicineColors();
            updateMedicineSelectAllCheckbox();
        }
    });
}

// 날짜 선택기 설정
function setupDatePicker() {
    const today = moment().format('YYYY-MM-DD');
    elements.datePicker.value = today;
    flatpickr(elements.datePicker, {
        locale: 'ko',
        dateFormat: 'Y-m-d',
        defaultDate: today,
        onChange: function(selectedDates, dateStr) {
            elements.datePicker.value = dateStr;
            filterPatientsByDate();
        }
    });
    filterPatientsByDate();
}

// 페이지 전환
function showMainPage() {
    // 비로그인 모드일 때는 메인 페이지로 이동 불가
    if (loginMode === 'no_login') {
        logMessage('⚠️ 비로그인 모드에서는 메인 페이지를 사용할 수 없습니다. 수동조제만 가능합니다.');
        return;
    }
    
    elements.mainPage.style.display = 'block';
    elements.networkPage.style.display = 'none';
    // 수동조제 페이지도 반드시 숨김
    const manualPage = document.getElementById('manualPage');
    if (manualPage) manualPage.style.display = 'none';
    
    filterPatientsByDate();
    // 자동조제 화면으로 전환 시 연결된 기기 상태 업데이트
    updateMainPageConnectedDevices();
}

function showNetworkPage() {
    elements.mainPage.style.display = 'none';
    elements.networkPage.style.display = 'block';
    // 수동조제 페이지도 반드시 숨김
    const manualPage = document.getElementById('manualPage');
    if (manualPage) manualPage.style.display = 'none';
}

// 로그 메시지
function logMessage(message) {
    const timestamp = moment().format('HH:mm:ss');
    const logEntry = document.createElement('div');
    logEntry.textContent = `[${timestamp}] ${message}`;
    elements.logContainer.appendChild(logEntry);
    elements.logContainer.scrollTop = elements.logContainer.scrollHeight;
    console.log(`[${timestamp}] ${message}`);
}

// 모든 네트워크 인터페이스 감지
async function detectAllNetworks() {
    try {
        logMessage('모든 네트워크 인터페이스 감지 중...');
        const allNetworks = await ipcRenderer.invoke('get-all-network-info');
        
        if (allNetworks && allNetworks.length > 0) {
            // 프리픽스를 기준으로 중복 제거
            const uniquePrefixes = new Set();
            networkInfoMap.clear();
            
            allNetworks.forEach(net => {
                if (!uniquePrefixes.has(net.prefix)) {
                    uniquePrefixes.add(net.prefix);
                    networkInfoMap.set(net.prefix, net);
                }
            });
            
            availableNetworks = Array.from(uniquePrefixes);
            
            // 우선순위에 따라 정렬된 네트워크 정보 가져오기
            const primaryNetwork = await ipcRenderer.invoke('get-network-info');
            if (primaryNetwork) {
                networkPrefix = primaryNetwork.prefix;
                logMessage(`주 네트워크: ${primaryNetwork.interface} (${primaryNetwork.address})`);
                logMessage(`네트워크 프리픽스: ${networkPrefix}`);
            } else if (availableNetworks.length > 0) {
                networkPrefix = availableNetworks[0];
                logMessage(`네트워크 프리픽스 (첫 번째): ${networkPrefix}`);
            }
            
            logMessage(`감지된 네트워크 수: ${availableNetworks.length}`);
            availableNetworks.forEach(prefix => {
                const net = networkInfoMap.get(prefix);
                if (net) {
                    logMessage(`  - ${prefix} (${net.interface}: ${net.address})`);
                }
            });
            
            return true;
        } else {
            logMessage('사용 가능한 네트워크를 찾을 수 없습니다.');
            return false;
        }
    } catch (error) {
        logMessage(`네트워크 감지 중 오류 발생: ${error.message}`);
        return false;
    }
}

// 네트워크 감지
async function detectNetworks() {
    try {
        logMessage('네트워크 인터페이스 감지 중...');
        const networkInfo = await ipcRenderer.invoke('get-network-info');
        
        if (networkInfo) {
            networkPrefix = networkInfo.prefix;
            availableNetworks = [networkPrefix];
            logMessage(`감지된 네트워크: ${networkInfo.interface} (${networkInfo.address})`);
            logMessage(`네트워크 프리픽스: ${networkPrefix}`);
            logMessage(`네트워크 마스크: ${networkInfo.netmask}`);
            logMessage(`연결 방식: ${networkInfo.interface.includes('Wi-Fi') || networkInfo.interface.includes('wlan') ? 'WiFi' : 'LAN'}`);
            logMessage(`설정된 네트워크 프리픽스: ${networkPrefix}`);
            
            // 네트워크 콤보박스 업데이트
            updateNetworkCombo();
            
            // 즉시 네트워크 스캔 시작
            scanNetwork();
        } else {
            logMessage('사용 가능한 네트워크를 찾을 수 없습니다.');
            await showMessage('warning', '사용 가능한 네트워크를 찾을 수 없습니다.\n수동으로 설정해주세요.');
            showNetworkSettingsDialog();
        }
    } catch (error) {
        logMessage(`네트워크 감지 중 오류 발생: ${error.message}`);
        await showMessage('warning', '네트워크 감지 중 오류가 발생했습니다.\n수동으로 설정해주세요.');
        showNetworkSettingsDialog();
    }
}

// 네트워크 콤보박스 업데이트
function updateNetworkCombo() {
    const networkCombo = document.getElementById('networkCombo');
    if (networkCombo) {
        networkCombo.innerHTML = '';
        availableNetworks.forEach(prefix => {
            const option = document.createElement('option');
            option.value = prefix;
            const netInfo = networkInfoMap.get(prefix);
            if (netInfo) {
                // 네트워크 인터페이스 이름과 IP 주소를 함께 표시
                option.textContent = `${prefix} (${netInfo.interface}: ${netInfo.address})`;
            } else {
                option.textContent = prefix;
            }
            networkCombo.appendChild(option);
        });
        if (availableNetworks.length > 0 && networkPrefix) {
            networkCombo.value = networkPrefix;
        } else if (availableNetworks.length > 0) {
            networkCombo.value = availableNetworks[0];
        }
    }
}

// 네트워크 설정 다이얼로그 표시
function showNetworkSettingsDialog() {
    const dialog = document.createElement('div');
    dialog.className = 'modal fade show';
    dialog.style.display = 'block';
    dialog.innerHTML = `
        <div class="modal-dialog">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">네트워크 설정</h5>
                    <button type="button" class="btn-close" onclick="closeNetworkDialog()"></button>
                </div>
                <div class="modal-body">
                    <p>네트워크 주소 범위를 입력하세요 (예: 192.168.1.)</p>
                    <input type="text" id="networkPrefixInput" class="form-control" placeholder="192.168.1.">
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-primary" onclick="saveNetworkPrefix()">확인</button>
                    <button type="button" class="btn btn-secondary" onclick="closeNetworkDialog()">취소</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);
}

// 네트워크 프리픽스 저장
function saveNetworkPrefix() {
    const input = document.getElementById('networkPrefixInput');
    const prefix = input.value.trim();
    
    if (prefix && prefix.endsWith('.')) {
        networkPrefix = prefix;
        if (!availableNetworks.includes(prefix)) {
            availableNetworks.push(prefix);
            updateNetworkCombo();
        }
        closeNetworkDialog();
        scanNetwork();
    } else {
        showMessage('error', '올바른 네트워크 주소 범위를 입력하세요.');
    }
}

// 네트워크 다이얼로그 닫기
function closeNetworkDialog() {
    const dialog = document.querySelector('.modal');
    if (dialog) {
        dialog.remove();
    }
}

// 네트워크 변경 이벤트
function onNetworkChanged() {
    const networkCombo = document.getElementById('networkCombo');
    if (networkCombo) {
        networkPrefix = networkCombo.value;
        scanNetwork();
    }
}

// 주기적 스캔 스케줄링
function scheduleScan() {
    scanNetwork(true); // 정기 스캔은 silent 모드
    scanInterval = setTimeout(scheduleScan, 10000); // 10초마다 스캔 (5초에서 변경)
}

// 네트워크 스캔 (arduino_connector.py 방식 적용)
async function scanNetwork(silent = false) {
    if (!networkPrefix) {
        if (!silent) {
            logMessage('네트워크 프리픽스가 설정되지 않았습니다.');
        }
        updateScanStatus('네트워크 프리픽스 없음', 'error');
        return;
    }
    
    if (!silent) {
        logMessage(`네트워크 스캔 시작: ${networkPrefix}0/24`);
    }
    updateScanStatus('스캔 중...', 'scanning');
    
    // 기존에 발견된 기기들을 유지하기 위해 현재 테이블의 기기 정보를 저장
    const existingDevices = new Map();
    const existingRows = elements.networkTableBody.querySelectorAll('tr:not(.empty-row)');
    existingRows.forEach(row => {
        const ip = row.cells[0].textContent;
        const mac = row.cells[1].textContent;
        if (ip && mac && ip !== '&nbsp;' && mac !== '&nbsp;') {
            existingDevices.set(mac, {
                ip: ip,
                status: row.cells[2].textContent,
                row: row
            });
        }
    });
    
    const results = {};
    const threads = [];
    
    // MAC 주소 정규화 함수
    const normalizeMac = (macStr) => {
        return macStr.replace(/[:\-]/g, '').toUpperCase();
    };
    
    // IP 체크 함수
    const checkIP = async (ip) => {
        try {
            console.log(`IP 체크 시도: ${ip}`);
            const response = await axios.get(`http://${ip}`, { 
                timeout: COMMUNICATION_CONFIG.TIMEOUTS.SCAN,
                headers: {
                    'User-Agent': 'SyrupDispenser/1.0'
                }
            });
            console.log(`IP 체크 응답: ${ip} - 상태: ${response.status}, 데이터:`, response.data);
            
            if (response.status === 200) {
                const data = response.data;
                if (data.status === 'ready' || data.mac) {
                    console.log(`유효한 기기 발견: ${ip} - MAC: ${data.mac}, 상태: ${data.status}`);
                    return data;
                } else {
                    console.log(`기기 응답이지만 유효하지 않음: ${ip} - 데이터:`, data);
                }
            }
        } catch (error) {
            // 타임아웃이나 연결 실패는 무시하되 로그는 남김
            if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                console.log(`IP 체크 타임아웃: ${ip}`);
            } else if (error.code === 'ECONNREFUSED') {
                console.log(`IP 체크 연결 거부: ${ip}`);
            } else {
                console.log(`IP 체크 오류: ${ip} - ${error.message}`);
            }
        }
        return null;
    };
    
    // 모든 IP에 대해 병렬로 체크
    for (let i = 1; i <= 255; i++) {
        const ip = `${networkPrefix}${i}`;
        const promise = checkIP(ip).then(data => {
            results[ip] = data;
        });
        threads.push(promise);
    }
    
    // 모든 스캔 완료 대기
    await Promise.all(threads);
    
    // 스캔 결과 로그 출력 (수동 스캔일 때만)
    let validDeviceCount = 0;
    for (const [ip, data] of Object.entries(results)) {
        if (data && data.mac) {
            validDeviceCount++;
        }
    }
    
    if (!silent) {
        logMessage(`=== 스캔 결과 전체 ===`);
        for (const [ip, data] of Object.entries(results)) {
            if (data && data.mac) {
                logMessage(`유효한 기기 발견: ${ip} - MAC: ${data.mac} - 상태: ${data.status || 'ready'}`);
            }
        }
        logMessage(`총 유효한 기기 수: ${validDeviceCount}`);
    }
    
    // 발견된 기기들 처리
    const foundDevices = {};
    const uniqueDevices = new Map(); // MAC 주소별로 고유한 기기만 저장
    
    for (const [ip, data] of Object.entries(results)) {
        if (data && data.mac) {
            const mac = data.mac;
            const normalizedMac = normalizeMac(mac);
            
            // IP 주소가 현재 네트워크 프리픽스와 일치하는지 확인
            // networkPrefix는 "172.30.1." 형태이므로 IP 주소가 이로 시작하는지 확인
            if (ip.startsWith(networkPrefix)) {
                // 중복 MAC 주소 처리 (같은 MAC이 여러 IP에서 발견되면 첫 번째만 유지)
                if (!uniqueDevices.has(normalizedMac)) {
                    uniqueDevices.set(normalizedMac, { ip, data, originalMac: mac });
                    foundDevices[normalizedMac] = ip;
                }
            }
        }
    }
    
    // 네트워크 테이블 업데이트 (기존 기기 유지하면서 새로운 기기 추가)
    if (!silent) {
        logMessage(`네트워크 범위 내 발견된 기기 수: ${uniqueDevices.size}`);
        logMessage(`=== 네트워크 테이블 업데이트 ===`);
    }
    
    // 기존 테이블에서 빈 행만 제거
    const emptyRows = elements.networkTableBody.querySelectorAll('tr.empty-row');
    emptyRows.forEach(row => row.remove());
    
    // 새로운 기기들 추가
    uniqueDevices.forEach((deviceInfo, normalizedMac) => {
        const { ip, data, originalMac } = deviceInfo;
        
        // 이미 테이블에 있는 기기인지 확인
        const existingDevice = existingDevices.get(originalMac);
        if (existingDevice) {
            // IP가 변경된 경우에만 로그 출력
            if (existingDevice.ip !== ip && !silent) {
                logMessage(`기존 기기 IP 업데이트: ${existingDevice.ip} -> ${ip} (MAC: ${originalMac})`);
            }
            // 기존 행의 IP 업데이트
            existingDevice.row.cells[0].textContent = ip;
            
            // 상태는 조제 중인 경우(dispensingDevices에 포함된 경우)에만 보존하고, 그 외에는 새로운 상태로 업데이트
            const currentStatus = existingDevice.row.cells[2].textContent;
            const isDispensing = dispensingDevices.has(existingDevice.deviceInfo.ip);
            if (isDispensing) {
                // 조제 중인 상태 유지 (ESP32는 듀얼코어로 통신 가능하므로 상태는 "연결됨" 유지)
            } else {
                // 조제 중이 아니면 새로운 상태로 업데이트
                existingDevice.row.cells[2].textContent = data.status || 'ready';
                // connectedDevices에서도 상태 업데이트
                for (const [deviceMac, deviceInfo] of Object.entries(connectedDevices)) {
                    if (normalizeMac(deviceMac) === normalizedMac) {
                        deviceInfo.status = "연결됨";
                        break;
                    }
                }
            }
            
            existingDevices.delete(originalMac); // 처리 완료 표시
        } else {
            // 새로운 기기가 발견된 경우에만 로그 출력
            if (!silent) {
                logMessage(`새로운 기기 발견: ${ip} (MAC: ${originalMac})`);
            }
            
            // 이미 저장된 연결인지 확인
            const isSaved = Object.keys(savedConnections).some(savedMac => 
                normalizeMac(savedMac) === normalizedMac
            );
            
            // 이미 연결된 기기인지 확인
            const isConnected = Object.keys(connectedDevices).some(connectedMac => 
                normalizeMac(connectedMac) === normalizedMac
            );
            
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${ip}</td>
                <td>${originalMac}</td>
                <td>${data.status || 'ready'}</td>
                <td>
                    <input type="text" class="form-control form-control-sm" placeholder="약품명" id="nickname_${originalMac}" ${isSaved ? 'disabled' : ''}>
                </td>
                <td>
                    <input type="text" class="form-control form-control-sm" placeholder="약품코드" id="pillcode_${originalMac}" ${isSaved ? 'disabled' : ''}>
                </td>
                <td>
                    ${isSaved ? 
                        `<span class="badge bg-success">저장됨</span>` :
                        `<button class="btn btn-primary btn-sm" onclick="saveConnection('${originalMac}', '${ip}')">저장</button>`
                    }
                </td>
            `;
            elements.networkTableBody.appendChild(row);
        }
    });
    
    // 더 이상 응답하지 않는 기기들 제거 (선택사항)
    existingDevices.forEach((deviceInfo, mac) => {
        // 연결된 기기는 일시적으로 응답하지 않아도 제거하지 않음
        const isConnectedDevice = Object.keys(connectedDevices).some(connectedMac => 
            normalizeMac(connectedMac) === normalizeMac(mac)
        );
        
        if (isConnectedDevice) {
            // 연결된 기기는 상태를 "일시적 응답 없음"으로 변경하되 테이블에서 제거하지 않음
            deviceInfo.row.cells[2].textContent = "일시적 응답 없음";
        } else {
            if (!silent) {
                logMessage(`응답하지 않는 기기 제거: ${deviceInfo.ip} (MAC: ${mac})`);
            }
            deviceInfo.row.remove();
        }
    });
    
    // 빈 행 추가하여 최소 5줄 유지
    const currentRows = elements.networkTableBody.querySelectorAll('tr:not(.empty-row)').length;
    const emptyRowsNeeded = Math.max(0, 5 - currentRows);
    for (let i = 0; i < emptyRowsNeeded; i++) {
        const emptyRow = document.createElement('tr');
        emptyRow.innerHTML = `
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
        `;
        emptyRow.classList.add('empty-row');
        elements.networkTableBody.appendChild(emptyRow);
    }
    
    if (!silent) {
        logMessage(`스캔 완료: ${uniqueDevices.size}개 기기 발견 (총 테이블 기기 수: ${elements.networkTableBody.querySelectorAll('tr:not(.empty-row)').length})`);
    }
    
    // 스캔 완료 상태 업데이트
    if (uniqueDevices.size > 0) {
        updateScanStatus(`${uniqueDevices.size}개 기기 발견`, 'success');
    } else {
        updateScanStatus('기기 없음', 'warning');
    }
    
    // 자동 재연결 시도
    await attemptAutoReconnect(foundDevices, silent);
}

function isValidIPv4(ip) {
    const parts = ip.trim().split('.');
    if (parts.length !== 4) return false;
    return parts.every(part => {
        const num = Number(part);
        return /^\d+$/.test(part) && num >= 0 && num <= 255;
    });
}

async function scanManualIP() {
    const input = document.getElementById('manualIpEntry');
    const ip = input ? input.value.trim() : '';
    if (!isValidIPv4(ip)) {
        logMessage('올바른 IPv4 주소를 입력하세요. (예: 192.168.10.53)');
        updateScanStatus('잘못된 IP', 'error');
        return;
    }

    logMessage(`수동 IP 조회: ${ip}`);
    updateScanStatus('조회 중...', 'scanning');

    try {
        const response = await axios.get(`http://${ip}`, {
            timeout: COMMUNICATION_CONFIG.TIMEOUTS.SCAN,
            headers: { 'User-Agent': 'SyrupDispenser/1.0' }
        });

        if (response.status !== 200 || !response.data || (!response.data.status && !response.data.mac)) {
            logMessage(`시럽조제기 응답 없음: ${ip}`);
            updateScanStatus('기기 없음', 'warning');
            return;
        }

        const data = response.data;
        const mac = data.mac;
        if (!mac) {
            logMessage(`MAC 주소를 확인할 수 없음: ${ip}`);
            updateScanStatus('기기 없음', 'warning');
            return;
        }

        const normalizeMac = (macStr) => macStr.replace(/[:\-]/g, '').toUpperCase();
        const normalizedMac = normalizeMac(mac);
        const rows = elements.networkTableBody.querySelectorAll('tr:not(.empty-row)');
        let existingRow = null;

        rows.forEach(row => {
            const rowMac = row.cells[1]?.textContent;
            if (rowMac && normalizeMac(rowMac) === normalizedMac) {
                existingRow = row;
            }
        });

        if (existingRow) {
            existingRow.cells[0].textContent = ip;
            existingRow.cells[2].textContent = data.status || 'ready';
            logMessage(`기존 기기 IP 업데이트: ${ip} (MAC: ${mac})`);
        } else {
            const emptyRows = elements.networkTableBody.querySelectorAll('tr.empty-row');
            emptyRows.forEach(row => row.remove());

            const isSaved = Object.keys(savedConnections).some(savedMac =>
                normalizeMac(savedMac) === normalizedMac
            );

            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${ip}</td>
                <td>${mac}</td>
                <td>${data.status || 'ready'}</td>
                <td>
                    <input type="text" class="form-control form-control-sm" placeholder="약품명" id="nickname_${mac}" ${isSaved ? 'disabled' : ''}>
                </td>
                <td>
                    <input type="text" class="form-control form-control-sm" placeholder="약품코드" id="pillcode_${mac}" ${isSaved ? 'disabled' : ''}>
                </td>
                <td>
                    ${isSaved ?
                        `<span class="badge bg-success">저장됨</span>` :
                        `<button class="btn btn-primary btn-sm" onclick="saveConnection('${mac}', '${ip}')">저장</button>`
                    }
                </td>
            `;
            elements.networkTableBody.appendChild(row);
            logMessage(`수동 조회로 기기 발견: ${ip} (MAC: ${mac})`);
        }

        updateScanStatus('조회 성공', 'success');
    } catch (error) {
        logMessage(`수동 IP 조회 실패: ${ip} - ${error.message}`);
        updateScanStatus('조회 실패', 'error');
    }
}

// 자동 재연결 시도 (arduino_connector.py 방식)
async function attemptAutoReconnect(foundDevices, silent = false) {
    // MAC 주소 정규화 함수
    const normalizeMac = (macStr) => {
        return macStr.replace(/[:\-]/g, '').toUpperCase();
    };
    
    let hasReconnectAttempt = false;
    
    for (const [savedMac, info] of Object.entries(savedConnections)) {
        const normalizedSavedMac = normalizeMac(savedMac);
        
        // 이미 연결되었거나 재연결 시도한 기기는 건너뛰기
        if (connectedDevices[savedMac]) {
            continue;
        }
        
        // 수동으로 연결을 끊은 기기는 자동 재연결하지 않음
        if (manuallyDisconnectedDevices.has(savedMac)) {
            continue;
        }
        
        // 재연결 시도 횟수 제한 (최대 3회)
        const attemptCount = autoReconnectAttempted.has(normalizedSavedMac) ? 
            autoReconnectAttempted.get(normalizedSavedMac) : 0;
        
        if (attemptCount >= 3) {
            continue;
        }
        
        // 발견된 기기 목록에서 MAC 주소로 찾기 (정규화된 MAC으로 비교)
        const foundIP = foundDevices[normalizedSavedMac];
        if (foundIP) {
            hasReconnectAttempt = true;
            logMessage(`자동 재연결 시도 (${attemptCount + 1}/3): ${info.nickname} (${savedMac}) -> ${foundIP}`);
            
            // IP 업데이트
            savedConnections[savedMac].ip = foundIP;
            
            // 자동 연결
            const success = await connectToDeviceByMac(savedMac, true);
            if (success) {
                autoReconnectAttempted.delete(normalizedSavedMac); // 성공하면 시도 기록 삭제
                logMessage(`자동 재연결 성공: ${info.nickname} (${foundIP})`);
            } else {
                // 실패 시 시도 횟수 증가
                autoReconnectAttempted.set(normalizedSavedMac, attemptCount + 1);
                logMessage(`자동 재연결 실패 (${attemptCount + 1}/3): ${info.nickname} (${foundIP})`);
            }
        }
    }
    
    // 실제로 재연결 시도가 있었을 때만 완료 메시지 출력
    if (hasReconnectAttempt && !silent) {
        // 로그는 이미 위에서 출력됨
    }
}

// MAC 주소로 기기 연결
async function connectToDeviceByMac(mac, silent = false) {
    if (!savedConnections[mac]) {
        if (!silent) {
            await showMessage('warning', '저장된 기기 정보를 찾을 수 없습니다.');
        }
        return false;
    }
    
    const deviceInfo = savedConnections[mac];
    const ip = deviceInfo.ip;
    
    // MAC 주소 정규화 함수
    const normalizeMac = (macStr) => {
        return macStr.replace(/[:\-]/g, '').toUpperCase();
    };
    
    logMessage(`연결 시도 시작: ${deviceInfo.nickname} (${ip})`);
    
    try {
        console.log(`연결 요청: http://${ip}`);
        const response = await axios.get(`http://${ip}`, { 
            timeout: COMMUNICATION_CONFIG.TIMEOUTS.CONNECTION_CHECK,
            headers: {
                'User-Agent': 'SyrupDispenser/1.0'
            }
        });
        
        console.log(`연결 응답: ${ip} - 상태: ${response.status}, 데이터:`, response.data);
        
        if (response.status === 200) {
            const data = response.data;
            if (data.mac) {
                // MAC 주소 정규화하여 비교
                const normalizedDeviceMac = normalizeMac(data.mac);
                const normalizedSavedMac = normalizeMac(mac);
                
                console.log(`MAC 비교: 기기=${data.mac}(${normalizedDeviceMac}) vs 저장된=${mac}(${normalizedSavedMac})`);
                
                if (normalizedDeviceMac === normalizedSavedMac) {
                    // 연결 성공
                    connectedDevices[mac] = {
                        ip: ip,
                        nickname: deviceInfo.nickname,
                        pill_code: deviceInfo.pill_code || '',
                        status: '연결됨'
                    };

                        // 수동 해제 목록에 남아있다면 연결 성공 시 제거하여 이후 자동연결/재연결 대상에 포함
                        if (manuallyDisconnectedDevices.has(mac)) {
                            manuallyDisconnectedDevices.delete(mac);
                            await saveConnections();
                            logMessage(`수동 해제 목록에서 제거: ${deviceInfo.nickname}`);
                        }
                    
                    updateConnectedTable();
                    updateMedicineColors();
                    
                    if (!silent) {
                        await showMessage('info', `${deviceInfo.nickname}에 연결되었습니다.`);
                    }
                    logMessage(`${deviceInfo.nickname} 연결 성공 (${ip})`);
                    return true;
                } else {
                    logMessage(`MAC 주소 불일치: 기기=${data.mac}(${normalizedDeviceMac}), 저장된=${mac}(${normalizedSavedMac})`);
                }
            } else {
                logMessage(`기기 응답에 MAC 주소가 없음: ${ip} - 응답:`, data);
            }
        } else {
            logMessage(`기기 응답 상태 코드 오류: ${ip} - 상태: ${response.status}`);
        }
    } catch (error) {
        console.log(`연결 오류 상세: ${ip} - ${error.code} - ${error.message}`);
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
            logMessage(`연결 타임아웃: ${deviceInfo.nickname} (${ip})`);
        } else if (error.code === 'ECONNREFUSED') {
            logMessage(`연결 거부: ${deviceInfo.nickname} (${ip})`);
        } else {
            logMessage(`연결 실패: ${deviceInfo.nickname} (${ip}) - ${error.message}`);
        }
    }
    
    if (!silent) {
        await showMessage('warning', '기기를 찾을 수 없습니다.');
    }
    return false;
}

// 기기 확인 (포트 지정 가능)
async function checkDevice(ip, port = 80) {
    try {
        const url = `http://${ip}:${port}`;
        console.log(`연결 시도: ${url}`);
        
        const response = await axios.get(url, { 
            timeout: 3000, // 타임아웃을 3초로 설정
            headers: {
                'User-Agent': 'SyrupDispenser/1.0'
            },
            // 연결 재시도 설정
            maxRedirects: 0,
            validateStatus: function (status) {
                return status >= 200 && status < 500; // 2xx, 3xx, 4xx 상태 코드 모두 허용
            }
        });
        
        console.log(`응답 받음: ${url} - 상태: ${response.status}, 데이터:`, response.data);
        
        if (response.status >= 200 && response.status < 300) {
            // 성공적인 응답
            if (response.data) {
                // 시럽조제기 응답 형식 확인
                if (response.data.mac || response.data.status === 'ready' || response.data.deviceType) {
                    return {
                        ip: ip,
                        port: port,
                        mac: response.data.mac || 'Unknown',
                        status: '온라인',
                        deviceType: response.data.deviceType || '시럽조제기'
                    };
                } else if (typeof response.data === 'string' && response.data.includes('mac')) {
                    // 문자열 형태의 응답에서 MAC 주소 추출 시도
                    const macMatch = response.data.match(/mac[:\s]*([0-9a-fA-F:]+)/i);
                    if (macMatch) {
                        return {
                            ip: ip,
                            port: port,
                            mac: macMatch[1],
                            status: '온라인',
                            deviceType: '시럽조제기'
                        };
                    }
                } else if (Object.keys(response.data).length > 0) {
                    // 응답 데이터가 있지만 예상 형식이 아닌 경우
                    console.log(`예상하지 못한 응답 형식: ${url}`, response.data);
                    return {
                        ip: ip,
                        port: port,
                        mac: 'Unknown',
                        status: '온라인',
                        deviceType: '기타 디바이스'
                    };
                }
            }
        } else if (response.status >= 300 && response.status < 400) {
            // 리다이렉트 응답 - 디바이스가 존재함을 의미
            console.log(`리다이렉트 응답: ${url} - 상태: ${response.status}`);
            return {
                ip: ip,
                port: port,
                mac: 'Unknown',
                status: '온라인',
                deviceType: '웹 서버'
            };
        } else if (response.status >= 400 && response.status < 500) {
            // 클라이언트 오류 - 디바이스는 존재하지만 요청이 거부됨
            console.log(`클라이언트 오류: ${url} - 상태: ${response.status}`);
            return {
                ip: ip,
                port: port,
                mac: 'Unknown',
                status: '온라인',
                deviceType: '웹 서버'
            };
        }
    } catch (error) {
        // 기기 없음 또는 연결 실패
        if (error.code === 'ECONNREFUSED') {
            // 연결 거부 - 해당 포트에서 서비스가 실행되지 않음
            console.log(`연결 거부: ${ip}:${port}`);
        } else if (error.code === 'ENOTFOUND') {
            // 호스트를 찾을 수 없음
            console.log(`호스트 없음: ${ip}:${port}`);
        } else if (error.code === 'ETIMEDOUT') {
            // 타임아웃 - 네트워크 지연 또는 방화벽
            console.log(`타임아웃: ${ip}:${port}`);
        } else if (error.code === 'ECONNABORTED') {
            // 연결 중단
            console.log(`연결 중단: ${ip}:${port}`);
        } else {
            console.log(`연결 실패: ${ip}:${port} - ${error.message}`);
        }
    }
    return null;
}

// 네트워크 테이블 업데이트 (MAC 주소 기반 중복 방지)
function updateNetworkTable() {
    elements.networkTableBody.innerHTML = '';
    
    // MAC 주소 정규화 함수
    const normalizeMac = (macStr) => {
        return macStr.replace(/[:\-]/g, '').toUpperCase();
    };
    
    // MAC 주소별로 고유한 디바이스만 표시 (중복 제거)
    const uniqueDevices = [];
    const seenMacs = new Set();
    
    availableNetworks.forEach(device => {
        const normalizedMac = normalizeMac(device.mac);
        if (!seenMacs.has(normalizedMac)) {
            seenMacs.add(normalizedMac);
            uniqueDevices.push(device);
        } else {
            // 중복된 MAC 주소가 있는 경우, 더 최근에 발견된 것으로 업데이트
            const existingIndex = uniqueDevices.findIndex(d => normalizeMac(d.mac) === normalizedMac);
            if (existingIndex >= 0) {
                uniqueDevices[existingIndex] = device;
            }
        }
    });
    
    uniqueDevices.forEach(device => {
        const row = document.createElement('tr');
        
        // 저장된 연결 정보와 비교하여 상태 표시
        let statusBadge = 'bg-success';
        let statusText = device.status;
        
        const savedConnection = Object.entries(savedConnections).find(([mac, conn]) => {
            return normalizeMac(mac) === normalizeMac(device.mac);
        });
        
        if (savedConnection) {
            statusBadge = 'bg-info';
            statusText = '저장됨';
        }
        
        row.innerHTML = `
            <td>${device.ip}:${device.port}</td>
            <td>${device.mac}</td>
            <td>${device.deviceType}</td>
            <td><span class="badge ${statusBadge}">${statusText}</span></td>
        `;
        elements.networkTableBody.appendChild(row);
    });
}

// 스캔 중지
function stopScan() {
    if (scanInterval) {
        clearInterval(scanInterval);
        scanInterval = null;
        logMessage('네트워크 스캔이 중지되었습니다.');
        updateScanStatus('스캔 중지됨', 'warning');
    }
    
    if (backgroundScanActive) {
        backgroundScanActive = false;
        logMessage('백그라운드 스캔이 중지되었습니다.');
        updateScanStatus('백그라운드 스캔 중지됨', 'warning');
    }
    
    if (!scanInterval && !backgroundScanActive) {
        logMessage('현재 실행 중인 스캔이 없습니다.');
        updateScanStatus('대기중', 'info');
    }
}

// 연결 정보 저장
async function saveConnection(mac, ip) {
    const nicknameInput = document.getElementById(`nickname_${mac}`);
    const pillCodeInput = document.getElementById(`pillcode_${mac}`);
    
    if (!nicknameInput || !pillCodeInput) {
        showMessage('warning', '기기 정보를 찾을 수 없습니다.');
        return;
    }
    
    const nickname = nicknameInput.value.trim();
    const pillCode = pillCodeInput.value.trim();
    
    if (!nickname) {
        showMessage('warning', '약품명을 입력해주세요.');
        return;
    }
    
    if (!pillCode) {
        showMessage('warning', '약품코드를 입력해주세요.');
        return;
    }
    
    savedConnections[mac] = {
        ip: ip,
        nickname: nickname,
        pill_code: pillCode
    };
    
    await saveConnections();
    updateSavedList();
    showMessage('info', '연결 정보가 저장되었습니다.');
    
    // 입력 필드 초기화
    nicknameInput.value = '';
    pillCodeInput.value = '';
}

// 저장된 연결 목록 업데이트
function updateSavedList() {
    elements.savedList.innerHTML = '';
    Object.entries(savedConnections).forEach(([mac, info]) => {
        const item = document.createElement('div');
        item.className = 'list-group-item';
        item.textContent = info.nickname;
        item.dataset.mac = mac;
        elements.savedList.appendChild(item);
    });
}

// 기기 연결
async function connectToDevice() {
    const selectedItem = document.querySelector('#savedList .list-group-item.active');
    if (!selectedItem) {
        await showMessage('warning', '연결할 기기를 선택해주세요.');
        return;
    }
    
    const mac = selectedItem.dataset.mac;
    
    if (connectedDevices[mac]) {
        await showMessage('info', '이미 연결된 기기입니다.');
        return;
    }
    
    const success = await connectToDeviceByMac(mac, false);
    if (success) {
        // 연결 성공 시 재연결 시도 목록에서 제거
        autoReconnectAttempted.delete(mac);
    }
}

// 연결된 기기 테이블 업데이트
function updateConnectedTable() {
    elements.connectedTableBody.innerHTML = '';
    Object.entries(connectedDevices).forEach(([mac, device]) => {
        const row = document.createElement('tr');

        let statusClass = 'status-disconnected';
        if (device.status === '연결됨') {
            statusClass = 'status-connected';
        }

        row.innerHTML = `
            <td>${device.nickname}</td>
            <td>${device.pill_code}</td>
            <td>${device.ip}</td>
            <td><span class="${statusClass}">${device.status}</span></td>
            <td>${moment().format('HH:mm:ss')}</td>
        `;
        elements.connectedTableBody.appendChild(row);
    });
    
    // 자동조제 화면의 간소화된 상태도 업데이트
    updateMainPageConnectedDevices();
}

// 자동조제 화면의 간소화된 연결 기기 상태 업데이트
function updateMainPageConnectedDevices() {
    const container = document.getElementById('mainPageConnectedDevices');
    if (!container) return;
    
    container.innerHTML = '';
    
    const deviceCount = Object.keys(connectedDevices).length;
    if (deviceCount === 0) {
        container.innerHTML = '<div class="text-muted text-center py-2">연결된 기기가 없습니다.</div>';
        return;
    }
    
    // 간소화된 카드 형태로 표시
    Object.entries(connectedDevices).forEach(([mac, device]) => {
        let statusClass = 'status-disconnected';
        let statusIcon = 'fa-times-circle';
        if (device.status === '연결됨') {
            statusClass = 'status-connected';
            statusIcon = 'fa-check-circle';
        }
        
        const deviceCard = document.createElement('div');
        deviceCard.className = 'd-flex align-items-center justify-content-between p-2 mb-1 border rounded';
        deviceCard.style.cssText = 'background-color: #f8f9fa;';
        deviceCard.innerHTML = `
            <div class="d-flex align-items-center flex-grow-1">
                <i class="fas ${statusIcon} me-2 ${statusClass}" style="font-size: 0.9rem;"></i>
                <div class="flex-grow-1">
                    <div class="fw-bold" style="font-size: 0.85rem;">${device.nickname}</div>
                    <div class="text-muted" style="font-size: 0.75rem;">${device.pill_code} | ${device.ip}</div>
                </div>
            </div>
            <span class="${statusClass} ms-2" style="font-size: 0.8rem; white-space: nowrap;">${device.status}</span>
        `;
        container.appendChild(deviceCard);
    });
}

// 기기 연결 해제
function disconnectDevice() {
    const selection = document.querySelector('#savedList .active');
    if (!selection) {
        showMessage('warning', '연결 해제할 기기를 선택해주세요.');
        return;
    }
    
    const mac = selection.dataset.mac;
    
    if (!connectedDevices[mac]) {
        showMessage('warning', '선택한 기기가 연결되어 있지 않습니다.');
        return;
    }
    
    // 연결된 기기에서 제거
    delete connectedDevices[mac];
    
    // 수동으로 연결을 끊은 기기로 기록
    manuallyDisconnectedDevices.add(mac);
    
    updateConnectedTable();
    updateMedicineColors();
    
    // 연결 상태 확인에서 해당 기기 제외
    logMessage(`기기 연결 해제: ${mac} (수동 해제로 기록됨)`);
    showMessage('info', '연결이 해제되었습니다.');
}

// 기기 삭제
async function deleteDevice() {
    const selection = document.querySelector('#savedList .active');
    if (!selection) {
        showMessage('warning', '삭제할 기기를 선택해주세요.');
        return;
    }
    
    const mac = selection.dataset.mac;
    
    if (mac in connectedDevices) {
        showMessage('warning', '연결된 기기는 삭제할 수 없습니다. 먼저 연결을 해제해주세요.');
        return;
    }
    
    delete savedConnections[mac];
    await saveConnections();
    updateSavedList();
    showMessage('info', '기기가 삭제되었습니다.');
}

// 연결 정보 저장/로드
async function saveConnections() {
    try {
        const filePath = await getConfigFilePath('connections.json');
        fs.writeFileSync(filePath, JSON.stringify({
            connections: savedConnections,
            manuallyDisconnectedDevices: Array.from(manuallyDisconnectedDevices)
        }, null, 2));
    } catch (error) {
        logMessage(`연결 정보 저장 중 오류: ${error.message}`);
    }
}

async function loadConnections() {
    try {
        const filePath = await getConfigFilePath('connections.json');
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            savedConnections = data.connections || {};
            
            // 수동으로 연결을 끊은 기기 목록 로드
            if (data.manuallyDisconnectedDevices) {
                manuallyDisconnectedDevices = new Set(data.manuallyDisconnectedDevices);
                logMessage(`수동으로 연결을 끊은 기기 목록 로드: ${Array.from(manuallyDisconnectedDevices).join(', ')}`);
            }
            
            updateSavedList();
            // 시럽조제기 목록이 로드된 후에만 수동조제 줄 복원
            if (document.getElementById('manualPage')) {
                loadManualRowsState();
            }
        }
    } catch (error) {
        logMessage(`연결 정보 로드 중 오류: ${error.message}`);
    }
}

// 처방전 경로 관리
async function selectPrescriptionPath() {
    const path = await ipcRenderer.invoke('select-directory');
    if (path) {
        elements.pathEntry.value = path;
        prescriptionPath = path;
        savePrescriptionPath();
    }
}

async function savePrescriptionPath() {
    const path = elements.pathEntry.value.trim();
    if (path && fs.existsSync(path)) {
        prescriptionPath = path;
        try {
            const filePath = await getConfigFilePath('prescription_path.txt');
            fs.writeFileSync(filePath, path);
            showMessage('info', '처방전 파일 경로가 저장되었습니다.');
            await parseAllPrescriptionFiles();
            startPrescriptionMonitor();
        } catch (error) {
            logMessage(`경로 저장 중 오류: ${error.message}`);
        }
    } else {
        showMessage('warning', '올바른 경로를 입력해주세요.');
    }
}

async function loadPrescriptionPath() {
    try {
        const filePath = await getConfigFilePath('prescription_path.txt');
        if (fs.existsSync(filePath)) {
            prescriptionPath = fs.readFileSync(filePath, 'utf8').trim();
            elements.pathEntry.value = prescriptionPath;
        }
    } catch (error) {
        logMessage(`경로 로드 중 오류: ${error.message}`);
    }
}

// 자동 조제 설정 저장
async function saveAutoDispensingSettings() {
    try {
        const settings = {
            autoDispensing: autoDispensing,
            maxSyrupAmount: maxSyrupAmount
        };
        const filePath = await getConfigFilePath('auto_dispensing_settings.json');
        fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf8');
        logMessage(`자동 조제 설정 저장됨: ${autoDispensing ? '활성화' : '비활성화'}, 시럽 최대량: ${maxSyrupAmount}mL`);
    } catch (error) {
        logMessage(`자동 조제 설정 저장 중 오류: ${error.message}`);
    }
}

// 자동 조제 설정 로드
async function loadAutoDispensingSettings() {
    try {
        const filePath = await getConfigFilePath('auto_dispensing_settings.json');
        if (fs.existsSync(filePath)) {
            const settings = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            autoDispensing = settings.autoDispensing || false;
            maxSyrupAmount = settings.maxSyrupAmount || 100;
            elements.autoDispensing.checked = autoDispensing;
            elements.maxSyrupAmount.value = maxSyrupAmount;
            logMessage(`자동 조제 설정 로드됨: ${autoDispensing ? '활성화' : '비활성화'}, 시럽 최대량: ${maxSyrupAmount}mL`);
        } else {
            // 기본값 설정
            autoDispensing = false;
            maxSyrupAmount = 100;
            elements.autoDispensing.checked = false;
            elements.maxSyrupAmount.value = maxSyrupAmount;
            logMessage('자동 조제 설정 파일이 없어 기본값으로 설정됨: 비활성화, 시럽 최대량: 100mL');
        }
    } catch (error) {
        logMessage(`자동 조제 설정 로드 중 오류: ${error.message}`);
        // 오류 발생 시 기본값 설정
        autoDispensing = false;
        maxSyrupAmount = 100;
        elements.autoDispensing.checked = false;
        elements.maxSyrupAmount.value = maxSyrupAmount;
    }
}

// 처방조제프로그램 설정 로드
function getPrescriptionWatchExtension() {
    if (prescriptionParseMode === 'pdf_bag') return '.pdf';
    return prescriptionProgram === 'pm3000' ? '.txt' : '.xml';
}

function updatePrescriptionPathDescription() {
    const titleEl = document.getElementById('prescriptionPathTitle');
    const pathEntry = document.getElementById('pathEntry');
    const pathHelp = document.getElementById('prescriptionPathHelp');
    const pdfHelp = document.getElementById('pdfBagIntegrationHelp');

    if (prescriptionParseMode === 'pdf_bag') {
        if (titleEl) titleEl.textContent = '약봉투 PDF 저장 경로 설정';
        if (pathEntry) pathEntry.placeholder = '약봉투 PDF가 저장되는 폴더를 선택하세요';
        if (pathHelp) pathHelp.textContent = '약봉투 출력 시 PDF가 자동 저장되는 폴더를 지정하세요. (예: C:\\AutoSyrup\\PDF) 물리 약봉투 출력은 그대로 유지됩니다.';
        if (pdfHelp) pdfHelp.textContent = '약봉투 PDF 폴더를 감시하여 환자·약물 정보를 가져옵니다. EMR TXT/XML 대신 PDF로 연동됩니다.';
    } else {
        if (titleEl) titleEl.textContent = '처방전 파일 경로 설정';
        if (pathEntry) pathEntry.placeholder = '처방전 파일 경로를 선택하세요';
        if (pathHelp) pathHelp.textContent = 'EMR에서 생성되는 TXT/XML 처방전 파일이 저장되는 폴더를 지정하세요.';
        if (pdfHelp) pdfHelp.textContent = '체크 시 약봉투 PDF 폴더를 감시하여 환자·약물 정보를 가져옵니다. (키오스크 접수 등 EMR TXT 미생성 시)';
    }
}

function extractReceiptDateFromReceiptNumber(receiptNumber, fallbackDate) {
    const dashed = receiptNumber.match(/(20\d{2}-\d{2}-\d{2})/);
    if (dashed) return dashed[1];

    const compact = receiptNumber.match(/(20\d{6})/);
    if (compact) {
        const datePart = compact[1];
        return `${datePart.substring(0, 4)}-${datePart.substring(4, 6)}-${datePart.substring(6, 8)}`;
    }
    return fallbackDate;
}

async function loadPdfParserConfig() {
    let config = null;
    try {
        const filePath = await getConfigFilePath('pdf_parser_config.json');
        if (fs.existsSync(filePath)) {
            config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (error) {
        logMessage(`PDF 파서 설정 로드 중 오류: ${error.message}`);
    }

    const template = await loadPdfBagTemplate();
    if (template) {
        config = config || {};
        config.customTemplate = template;
    }
    return config;
}

let pendingPdfBagTemplatePath = '';
let pdfBagTemplate = null;

async function loadPdfBagTemplate() {
    try {
        const filePath = await getConfigFilePath('pdf_bag_template.json');
        if (fs.existsSync(filePath)) {
            pdfBagTemplate = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            updatePdfBagTemplateStatus();
            return pdfBagTemplate;
        }
    } catch (error) {
        logMessage(`약봉투 양식 로드 중 오류: ${error.message}`);
    }
    pdfBagTemplate = null;
    updatePdfBagTemplateStatus();
    return null;
}

async function savePdfBagTemplate(template) {
    const filePath = await getConfigFilePath('pdf_bag_template.json');
    fs.writeFileSync(filePath, JSON.stringify(template, null, 2), 'utf8');
    pdfBagTemplate = template;
    updatePdfBagTemplateStatus();
}

async function clearPdfBagTemplate() {
    try {
        const filePath = await getConfigFilePath('pdf_bag_template.json');
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        logMessage(`약봉투 양식 삭제 중 오류: ${error.message}`);
    }

    pdfBagTemplate = null;
    pendingPdfBagTemplatePath = '';
    updatePdfBagTemplateStatus();
    logMessage('약봉투 양식이 삭제되었습니다. 기본 파싱 방식으로 동작합니다.');

    parsedFiles.clear();
    parsedPrescriptions = {};
    await parseAllPrescriptionFiles();
}

function updatePdfBagTemplateStatus() {
    const fileLabel = document.getElementById('pdfBagTemplateFileLabel');
    const statusEl = document.getElementById('pdfBagTemplateStatus');
    const previewEl = document.getElementById('pdfBagTemplatePreview');
    const saveBtn = document.getElementById('savePdfBagTemplateBtn');
    const clearBtn = document.getElementById('clearPdfBagTemplateBtn');

    if (pdfBagTemplate) {
        if (fileLabel) {
            fileLabel.textContent = `등록된 양식: ${pdfBagTemplate.sourceFileName || '알 수 없음'} (${pdfBagTemplate.registeredAt ? pdfBagTemplate.registeredAt.substring(0, 10) : ''})`;
        }
        if (statusEl) {
            if (pdfBagTemplate.templateVersion >= 3 && pdfBagTemplate.learned) {
                const regionLabel = {
                    rows_after_header: '표 형식 (헤더 아래 약물 행)',
                    matrix_before_header: '세로 열 형식 (헤더 위 숫자 블록)',
                    labeled_blocks: '용법 라벨 블록 형식',
                    stacked_compact: '시럽 단일약 (약품명+용법 분리 행)'
                }[pdfBagTemplate.learned.regionType || pdfBagTemplate.learned.strategy] || '자동 학습';
                statusEl.textContent = `학습된 양식 (v3): ${regionLabel} — 샘플 PDF 구조를 저장해 동일 양식을 파싱합니다.`;
            } else if (pdfBagTemplate.templateVersion >= 2 && pdfBagTemplate.learned) {
                const strategyLabel = {
                    header_table: '표 헤더형 (약품명·투약량·횟수·일수)',
                    column_matrix: '세로 열형 (일수/횟수/투약량)',
                    label_block: '용법 라벨형 (1회투약량/1일투여횟수)'
                }[pdfBagTemplate.learned.strategy] || pdfBagTemplate.learned.strategy;
                statusEl.textContent = `학습된 양식 (v2): ${strategyLabel} — 샘플 PDF에서 구조를 학습해 파싱합니다.`;
            } else {
                statusEl.textContent = `용법 레이아웃: ${pdfBagTemplate.dosageLayout || 'per_drug_block'} — 이 양식으로 PDF를 파싱합니다.`;
            }
        }
        if (previewEl && pdfBagTemplate.preview) {
            const preview = pdfBagTemplate.preview;
            const meds = (preview.medicines || []).map(m => `  • ${m.pill_name} ${m.volume}/${m.daily}/${m.period}`).join('\n');
            previewEl.textContent = `환자: ${preview.patientName || '-'}\n접수번호: ${preview.prescriptionNo || '-'}\n약물 ${(preview.medicines || []).length}개\n${meds}`;
            previewEl.style.display = 'block';
        }
        if (clearBtn) clearBtn.disabled = false;
    } else {
        if (fileLabel) {
            fileLabel.textContent = pendingPdfBagTemplatePath
                ? `선택된 PDF: ${path.basename(pendingPdfBagTemplatePath)}`
                : '등록된 양식 PDF 없음';
        }
        if (statusEl) {
            statusEl.textContent = pendingPdfBagTemplatePath
                ? '「양식 분석 및 저장」을 눌러 이 PDF 양식을 등록하세요.'
                : '사용 중인 약봉투 PDF 샘플 1장을 선택하면 해당 양식에 맞게 파싱합니다.';
        }
        if (previewEl) previewEl.style.display = 'none';
        if (clearBtn) clearBtn.disabled = true;
    }

    if (saveBtn) {
        saveBtn.disabled = !pendingPdfBagTemplatePath;
    }
}

async function selectPdfBagTemplateFile() {
    const selectedPath = await ipcRenderer.invoke('select-pdf-file');
    if (!selectedPath) return;

    pendingPdfBagTemplatePath = selectedPath;
    updatePdfBagTemplateStatus();
    logMessage(`약봉투 양식 PDF 선택됨: ${path.basename(selectedPath)}`);
}

async function registerPdfBagTemplate() {
    if (!pendingPdfBagTemplatePath) {
        showMessage('warning', '먼저 양식 PDF 파일을 선택해주세요.');
        return;
    }

    logMessage(`약봉투 양식 분석 시작: ${path.basename(pendingPdfBagTemplatePath)}`);
    const analysis = await ipcRenderer.invoke('analyze-pdf-bag-template', pendingPdfBagTemplatePath);

    if (!analysis.success) {
        showMessage('error', `양식 분석 실패: ${analysis.error || '알 수 없는 오류'}`);
        logMessage(`약봉투 양식 분석 실패: ${analysis.error || '알 수 없는 오류'}`);
        return;
    }

    if (!analysis.preview || !analysis.preview.parseSuccess) {
        const preview = analysis.preview || {};
        showMessage('warning', `양식 분석 결과가 불완전합니다.\n환자: ${preview.patientName || '없음'}\n약물: ${(preview.medicines || []).length}개\n\n다른 샘플 PDF를 시도하거나 PDF 텍스트 추출이 가능한지 확인해주세요.`);
        logMessage(`약봉투 양식 분석 불완전: 환자=${preview.patientName || '없음'}, 약물=${(preview.medicines || []).length}개`);
        return;
    }

    const templateToSave = {
        ...analysis.template,
        sourceFileName: analysis.fileName,
        registeredAt: new Date().toISOString(),
        preview: analysis.preview
    };

    await savePdfBagTemplate(templateToSave);
    pendingPdfBagTemplatePath = '';

    const meds = analysis.preview.medicines.map(m => `${m.pill_name}(${m.volume}/${m.daily}/${m.period})`).join(', ');
    const strategyInfo = analysis.template.templateVersion >= 2 && analysis.template.learned
        ? `\n학습 방식: ${analysis.template.learned.strategy}`
        : '';
    logMessage(`약봉투 양식 등록 완료: ${analysis.preview.patientName} / ${analysis.preview.prescriptionNo} / ${meds}${strategyInfo ? ' (' + analysis.template.learned.strategy + ')' : ''}`);
    showMessage('info', `약봉투 양식이 등록되었습니다.\n환자: ${analysis.preview.patientName}\n접수번호: ${analysis.preview.prescriptionNo}\n약물: ${meds}${strategyInfo}`);

    parsedFiles.clear();
    parsedPrescriptions = {};
    await parseAllPrescriptionFiles();
}

window.selectPdfBagTemplateFile = selectPdfBagTemplateFile;
window.registerPdfBagTemplate = registerPdfBagTemplate;
window.clearPdfBagTemplate = clearPdfBagTemplate;

function syncPdfBagIntegrationCheckbox() {
    const pdfCheckbox = document.getElementById('pdfBagIntegration');
    if (pdfCheckbox) {
        pdfCheckbox.checked = prescriptionParseMode === 'pdf_bag';
    }
}

async function loadPrescriptionProgramSettings() {
    try {
        const filePath = await getConfigFilePath('prescription_program_settings.json');
        if (fs.existsSync(filePath)) {
            const settings = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            prescriptionProgram = settings.prescriptionProgram || 'pm3000';
            if (typeof settings.pdfBagIntegration === 'boolean') {
                prescriptionParseMode = settings.pdfBagIntegration ? 'pdf_bag' : 'emr_file';
            } else {
                prescriptionParseMode = settings.prescriptionParseMode || 'emr_file';
            }
            const programSelect = document.getElementById('prescriptionProgram');
            if (programSelect) {
                programSelect.value = prescriptionProgram;
            }
            syncPdfBagIntegrationCheckbox();
            updatePrescriptionPathDescription();
            logMessage(`처방조제프로그램 설정 로드됨: ${prescriptionProgram === 'pm3000' ? 'PM3000, 팜플러스20' : '유팜'}`);
            logMessage(`약봉투 PDF 연동: ${prescriptionParseMode === 'pdf_bag' ? '사용' : '미사용'}`);
        } else {
            // 기본값 설정
            prescriptionProgram = 'pm3000';
            prescriptionParseMode = 'emr_file';
            const programSelect = document.getElementById('prescriptionProgram');
            if (programSelect) {
                programSelect.value = prescriptionProgram;
            }
            syncPdfBagIntegrationCheckbox();
            updatePrescriptionPathDescription();
            logMessage('처방조제프로그램 설정 파일이 없어 기본값으로 설정됨: PM3000, 팜플러스20');
        }
    } catch (error) {
        logMessage(`처방조제프로그램 설정 로드 중 오류: ${error.message}`);
        // 오류 발생 시 기본값 설정
        prescriptionProgram = 'pm3000';
        prescriptionParseMode = 'emr_file';
        const programSelect = document.getElementById('prescriptionProgram');
        if (programSelect) {
            programSelect.value = prescriptionProgram;
        }
        syncPdfBagIntegrationCheckbox();
        updatePrescriptionPathDescription();
    }
}

// 처방조제프로그램 설정 저장
async function savePrescriptionProgramSettings() {
    try {
        const settings = {
            prescriptionProgram: prescriptionProgram,
            pdfBagIntegration: prescriptionParseMode === 'pdf_bag',
            prescriptionParseMode: prescriptionParseMode
        };
        const filePath = await getConfigFilePath('prescription_program_settings.json');
        fs.writeFileSync(filePath, JSON.stringify(settings, null, 2));
        logMessage(`처방조제프로그램 설정 저장됨: ${prescriptionProgram === 'pm3000' ? 'PM3000, 팜플러스20' : '유팜'}`);
        logMessage(`약봉투 PDF 연동 저장됨: ${prescriptionParseMode === 'pdf_bag' ? '사용' : '미사용'}`);
    } catch (error) {
        logMessage(`처방조제프로그램 설정 저장 중 오류: ${error.message}`);
    }
}

// 처방조제프로그램 변경 이벤트
async function onPrescriptionProgramChanged() {
    const programSelect = document.getElementById('prescriptionProgram');
    if (programSelect) {
        prescriptionProgram = programSelect.value;
        await savePrescriptionProgramSettings();
        logMessage(`처방조제프로그램 변경됨: ${prescriptionProgram === 'pm3000' ? 'PM3000, 팜플러스20' : '유팜'}`);
        
        if (prescriptionParseMode === 'pdf_bag') {
            return;
        }
        
        // 기존 파싱된 데이터 초기화
        parsedFiles.clear();
        parsedPrescriptions = {};
        
        // 새로운 프로그램에 맞게 파일 다시 파싱
        await parseAllPrescriptionFiles();
        startPrescriptionMonitor();
    }
}

// 약봉투 PDF 연동 체크박스 변경 이벤트
async function onPdfBagIntegrationChanged() {
    const pdfCheckbox = document.getElementById('pdfBagIntegration');
    if (!pdfCheckbox) return;

    prescriptionParseMode = pdfCheckbox.checked ? 'pdf_bag' : 'emr_file';
    await savePrescriptionProgramSettings();
    updatePrescriptionPathDescription();
    logMessage(`약봉투 PDF 연동 ${pdfCheckbox.checked ? '활성화' : '비활성화'}`);

    parsedFiles.clear();
    parsedPrescriptions = {};
    await parseAllPrescriptionFiles();
    startPrescriptionMonitor();
}

// 처방전 파일 파싱
async function parseAllPrescriptionFiles() {
    if (!prescriptionPath) {
        logMessage('처방전 경로가 설정되지 않았습니다.');
        return;
    }
    
    // 비로그인 모드 확인
    if (loginMode === 'no_login') {
        logMessage('⚠️ 비로그인 모드에서는 처방전연동 기능을 사용할 수 없습니다.');
        return;
    }
    
    // 파싱 기능 활성화 여부 확인
    if (!parseEnabled) {
        logMessage('⚠️ 처방전연동 기능이 비활성화되어 있습니다. 과금 상태를 확인해주세요.');
        return;
    }
    
    // 약국 등록 및 승인 상태 확인
    if (pharmacyStatus === null) {
        logMessage('⚠️ 약국 등록이 필요합니다. 등록 후 처방전연동 기능을 사용할 수 있습니다.');
        return;
    }
    
    if (pharmacyStatus === 'pending') {
        logMessage('⚠️ 약국 승인 대기 중입니다. 관리자 승인 후 처방전연동 기능이 활성화됩니다.');
        return;
    }
    
    if (pharmacyStatus === 'rejected') {
        logMessage('❌ 약국 등록이 거부되었습니다. 관리자에게 문의하세요.');
        return;
    }
    
    logMessage(`처방전 파일 처방전연동 시작: ${prescriptionPath}`);
    
    try {
        const fileExtension = getPrescriptionWatchExtension();
        const files = fs.readdirSync(prescriptionPath)
            .filter(file => file.toLowerCase().endsWith(fileExtension))
            .map(file => path.join(prescriptionPath, file));
        
        logMessage(`발견된 파일 수: ${files.length}`);
        
        for (const filePath of files) {
            parsedFiles.delete(filePath);
            await parsePrescriptionFile(filePath);
        }
        
        filterPatientsByDate();
    } catch (error) {
        logMessage(`처방전 파일 처방전연동 중 오류: ${error.message}`);
    }
}

/**
 * 이벤트 전송 없이 파일 파싱만 (프로그램 시작 시 사용)
 */
function parsePrescriptionFileWithoutEvent(filePath) {
    // 프로그램 시작 시에는 parsedFiles 체크 없이 항상 파싱 (리스트 표시용)
    console.log(`🟢 parsePrescriptionFileWithoutEvent 호출: ${path.basename(filePath)}`);
    
    try {
        const buffer = fs.readFileSync(filePath);
        const content = buffer.toString('utf8');
        const lines = content.split('\n');
        
        console.log(`📄 파일 라인 수: ${lines.length}`);
        if (lines.length < 2) {
            console.log(`⚠️ 라인 수 부족: ${path.basename(filePath)}`);
            return;
        }
        
        const firstLine = lines[0].trim();
        const parts = firstLine.split('\\');
        
        console.log(`📝 첫 줄 파트 수: ${parts.length}, 내용: ${firstLine.substring(0, 50)}`);
        if (parts.length >= 3) {
            const patientName = parts[0];
            const receiptDate = parts[1];
            const receiptNumber = parts[2];
            
            const medicines = lines.slice(1).map((line, index) => {
                const parts = line.trim().split('\\');
                if (parts.length >= 8) {
                    return {
                        pill_code: parts[0],
                        pill_name: parts[1],
                        volume: parseInt(parts[2]),
                        daily: parseInt(parts[3]),
                        period: parseInt(parts[4]),
                        total: parseInt(parts[5]),
                        date: parts[6],
                        line_number: parseInt(parts[7])
                    };
                }
                return null;
            }).filter(medicine => medicine !== null);
            
            medicines.sort((a, b) => a.line_number - b.line_number);
            
            parsedPrescriptions[receiptNumber] = {
                patient: {
                    name: patientName,
                    receipt_time: receiptDate,
                    receipt_date: receiptDate,
                    receipt_number: receiptNumber,
                    parsed_at: moment().format('YYYY-MM-DD HH:mm:ss')
                },
                medicines: medicines
            };
            
            console.log(`✅ parsedPrescriptions에 추가: ${receiptNumber}`);
            // parsedFiles에 추가하지 않음 (리스트 표시만 하고, 새 파일 감지는 startPrescriptionMonitor에서 처리)
            // logMessage(`기존 파일 파싱 완료: ${path.basename(filePath)} (이벤트 전송 없음)`);
        } else {
            console.log(`❌ 파트 수 부족으로 파싱 실패: ${path.basename(filePath)}`);
        }
    } catch (error) {
        logMessage(`파일 처방전연동 중 오류: ${error.message}`);
    }
}

async function parsePrescriptionFile(filePath) {
    console.log(`🔵 parsePrescriptionFile 호출됨: ${path.basename(filePath)}`);
    console.log(`📂 parsedFiles.has(${path.basename(filePath)}): ${parsedFiles.has(filePath)}`);
    
    if (parsedFiles.has(filePath)) {
        console.log(`⚠️ 이미 파싱된 파일이므로 스킵: ${path.basename(filePath)}`);
        return;
    }
    
    // 디버깅: 현재 상태 확인
    console.log(`[파싱 체크] loginMode: ${loginMode}, parseEnabled: ${parseEnabled}, pharmacyStatus: ${pharmacyStatus}, 파일: ${path.basename(filePath)}`);
    
    // 비로그인 모드 확인
    if (loginMode === 'no_login') {
        console.log(`🚫 [파싱 차단] 비로그인 모드입니다. 파일: ${path.basename(filePath)}`);
        logMessage(`⚠️ 비로그인 모드에서는 처방전연동 기능을 사용할 수 없습니다. 로그인 후 처방전연동 기능을 사용하세요.`);
        return;
    }
    
    // 파싱 기능 활성화 여부 확인
    if (!parseEnabled) {
        console.log(`🚫 [파싱 차단] 파싱 기능이 비활성화되어 있습니다. 파일: ${path.basename(filePath)}`);
        logMessage(`⚠️ 처방전연동 기능이 비활성화되어 있습니다. 과금 상태를 확인해주세요.`);
        return;
    }
    
    // 약국 등록 및 승인 상태 확인
    if (pharmacyStatus === null) {
        console.log(`❌ [파싱 차단] pharmacyStatus가 null입니다. 파일: ${path.basename(filePath)}`);
        logMessage(`⚠️ 약국 등록이 필요합니다. 파일 '${path.basename(filePath)}'은 등록 후 처방전연동됩니다.`);
        return;
    }
    
    if (pharmacyStatus === 'pending') {
        console.log(`⏳ [파싱 차단] pharmacyStatus가 pending입니다. 파일: ${path.basename(filePath)}`);
        logMessage(`⚠️ 약국 승인 대기 중입니다. 파일 '${path.basename(filePath)}'은 승인 후 처방전연동됩니다.`);
        return;
    }
    
    if (pharmacyStatus === 'rejected') {
        console.log(`🚫 [파싱 차단] pharmacyStatus가 rejected입니다. 파일: ${path.basename(filePath)}`);
        logMessage(`❌ 약국 등록이 거부되었습니다. 처방전연동 기능을 사용할 수 없습니다.`);
        return;
    }
    
    console.log(`✅ [파싱 허용] pharmacyStatus가 active입니다. 파일: ${path.basename(filePath)}`);
    
    if (prescriptionParseMode === 'pdf_bag') {
        try {
            const parserConfig = await loadPdfParserConfig();
            const parsed = await ipcRenderer.invoke('parse-pdf-file', filePath, parserConfig);

            if (parsed.error) {
                logMessage(`PDF 파싱 중 오류: ${path.basename(filePath)} - ${parsed.error}`);
                return null;
            }

            if (!parsed.parseSuccess) {
                if (parsed.parserUsed === 'test_skip') {
                    logMessage(`ℹ️ 테스트 PDF는 건너뜀: ${path.basename(filePath)}`);
                } else {
                    logMessage(`⚠️ PDF 파싱 실패: ${path.basename(filePath)} (환자명 또는 약물 정보를 찾지 못함)`);
                }
                return null;
            }

            const receiptNumber = extractReceiptNumberFromPdfPath(filePath, parsed);
            const stats = fs.statSync(filePath);
            const creationTime = moment(stats.birthtime).format('YYYY-MM-DD HH:mm:ss');
            const currentTime = moment().format('YYYY-MM-DD HH:mm:ss');
            const receiptTime = stats.birthtime.getTime() > 0 ? creationTime : currentTime;
            const fallbackDate = moment(stats.birthtime).format('YYYY-MM-DD');
            const receiptDate = parsed.receiptDate || extractReceiptDateFromReceiptNumber(receiptNumber, fallbackDate);

            const medicines = parsed.medicines.map((med, index) => ({
                pill_code: med.pill_code || '',
                pill_name: med.pill_name,
                volume: med.volume || 0,
                daily: med.daily || 0,
                period: med.period || 0,
                total: med.total || (med.volume * med.daily * med.period),
                date: med.date || receiptDate.replace(/-/g, ''),
                line_number: med.line_number || (index + 1)
            }));

            medicines.sort((a, b) => a.line_number - b.line_number);

            parsedPrescriptions[receiptNumber] = {
                patient: {
                    name: parsed.patientName,
                    receipt_time: receiptTime,
                    receipt_date: receiptDate,
                    receipt_number: receiptNumber,
                    parsed_at: currentTime
                },
                medicines
            };

            parsedFiles.add(filePath);
            saveParsedFiles();
            logMessage(`PDF 파싱 완료: ${path.basename(filePath)} → ${receiptNumber} (환자: ${parsed.patientName}, 약물 ${medicines.length}개)`);
            return receiptNumber;
        } catch (error) {
            logMessage(`PDF 파싱 중 오류: ${path.basename(filePath)} - ${error.message}`);
            return null;
        }
    }
    
    try {
        const buffer = fs.readFileSync(filePath);
        let content = '';
        
        // 선택된 프로그램에 따라 파일 확장자 결정
        const fileExtension = prescriptionProgram === 'pm3000' ? '.txt' : '.xml';
        const receiptNumber = path.basename(filePath, fileExtension);
        
        if (prescriptionProgram === 'pm3000') {
            // PM3000, 팜플러스20 - TXT 파일 파싱
            let decoded = false;
            let bestContent = null;
            let bestEncoding = 'utf8';
            // 인코딩 우선순위: cp949 → euc-kr → utf8
            const encodings = ['cp949', 'euc-kr', 'utf8'];

            for (const encoding of encodings) {
                try {
                    const testContent = iconv.decode(buffer, encoding);
                    // 첫 번째 줄(환자명) 추출
                    const firstLine = testContent.split('\n')[0]?.trim() || '';
                    
                    // 첫 줄이 유효한지 확인 (빈 줄이 아니고, 너무 짧지 않음)
                    if (firstLine.length === 0 || firstLine.length > 100) {
                        continue;
                    }
                    
                    // 깨진 문자 확인 (인코딩 오류 시 나타나는 특수 문자들)
                    const hasBrokenChars = /[\uFFFD\u0000-\u001F\u007F-\u009F]/.test(firstLine);
                    if (hasBrokenChars) {
                        continue; // 깨진 문자가 있으면 이 인코딩은 제외
                    }
                    
                    // 한글이 포함되어 있는지 확인
                    const hasKorean = /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(firstLine);
                    
                    if (hasKorean) {
                        // 한글이 제대로 보이면 이 인코딩 사용
                        content = testContent;
                        bestContent = testContent;
                        bestEncoding = encoding;
                        decoded = true;
                        break;
                    } else if (!decoded) {
                        // 한글이 없어도 깨지지 않았으면 후보로 저장
                        bestContent = testContent;
                        bestEncoding = encoding;
                    }
                } catch (error) {
                    continue;
                }
            }
            
            if (!decoded) {
                // 디코딩 실패 시 최선의 후보 사용 또는 utf8 기본값
                if (bestContent) {
                    content = bestContent;
                } else {
                    content = iconv.decode(buffer, 'utf8');
                }
            }

            const lines = content.toString().split('\n').filter(line => line.trim());
            if (lines.length === 0) return;
            
            const patientName = lines[0].trim();
            
            // 파일명에서 날짜 추출 (YYYYMMDD 형식)
            const datePart = receiptNumber.substring(0, 8);
            const year = datePart.substring(0, 4);
            const month = datePart.substring(4, 6);
            const day = datePart.substring(6, 8);
            const receiptDate = `${year}-${month}-${day}`;
            
            // 파일의 실제 생성 시간 가져오기
            const stats = fs.statSync(filePath);
            const creationTime = moment(stats.birthtime).format('YYYY-MM-DD HH:mm:ss');
            const currentTime = moment().format('YYYY-MM-DD HH:mm:ss');
            
            // 파일 생성 시간이 유효하지 않으면 현재 시간 사용
            const receiptTime = stats.birthtime.getTime() > 0 ? creationTime : currentTime;
            
            const medicines = lines.slice(1).map((line, index) => {
                // 백슬래시로 split 시도
                let parts = line.trim().split('\\');
                
                if (parts.length === 7) {
                    // 팜플러스20 형식: 7개 필드 (pill_code, pill_name, volume, daily, period, date, line_number)
                    // total이 없으므로 계산
                    const volume = parseInt(parts[2]) || 0;
                    const daily = parseInt(parts[3]) || 0;
                    const period = parseInt(parts[4]) || 0;
                    return {
                        pill_code: parts[0],
                        pill_name: parts[1],
                        volume: volume,
                        daily: daily,
                        period: period,
                        total: volume * daily * period, // total은 계산
                        date: parts[5],
                        line_number: parseInt(parts[6]) || (index + 1)
                    };
                } else if (parts.length >= 8) {
                    // PM3000 형식: 8개 필드 (pill_code, pill_name, volume, daily, period, total, date, line_number)
                    return {
                        pill_code: parts[0],
                        pill_name: parts[1],
                        volume: parseInt(parts[2]),
                        daily: parseInt(parts[3]),
                        period: parseInt(parts[4]),
                        total: parseInt(parts[5]),
                        date: parts[6],
                        line_number: parseInt(parts[7])
                    };
                } else if (line.includes('₩')) {
                    // 원화 기호를 구분자로 사용하는 경우 (7개 필드)
                    parts = line.trim().split('₩');
                    if (parts.length >= 7) {
                        const volume = parseInt(parts[2]) || 0;
                        const daily = parseInt(parts[3]) || 0;
                        const period = parseInt(parts[4]) || 0;
                        return {
                            pill_code: parts[0],
                            pill_name: parts[1],
                            volume: volume,
                            daily: daily,
                            period: period,
                            total: volume * daily * period,
                            date: parts[5],
                            line_number: parseInt(parts[6]) || (index + 1)
                        };
                    }
                }
                
                // 파싱 실패 시 로그 출력
                logMessage(`약물 파싱 실패: ${line.substring(0, 50)}... (필드 수: ${parts.length})`);
                return null;
            }).filter(medicine => medicine !== null);
            
            medicines.sort((a, b) => a.line_number - b.line_number);
            
            parsedPrescriptions[receiptNumber] = {
                patient: {
                    name: patientName,
                    receipt_time: receiptTime,
                    receipt_date: receiptDate,
                    receipt_number: receiptNumber,
                    parsed_at: currentTime
                },
                medicines: medicines
            };
            
            parsedFiles.add(filePath);
            saveParsedFiles(); // parsedFiles 저장
            return receiptNumber;
            
        } else {
            // 유팜 - XML 파일 파싱
            content = buffer.toString('utf8');
            
            // XML 파싱을 위한 간단한 정규식 사용
            const orderNumMatch = content.match(/<OrderNum>([^<]+)<\/OrderNum>/);
            const orderDtMatch = content.match(/<OrderDt>([^<]+)<\/OrderDt>/);
            const orderDtmMatch = content.match(/<OrderDtm>([^<]+)<\/OrderDtm>/);
            const ptntNmMatch = content.match(/<PtntNm>([^<]+)<\/PtntNm>/);
            
            if (!orderNumMatch || !ptntNmMatch) {
                logMessage(`유팜 XML 파일 처방전연동 실패: 필수 정보 누락 - ${path.basename(filePath)}`);
                return;
            }
            
            const orderNum = orderNumMatch[1];
            const orderDt = orderDtMatch ? orderDtMatch[1] : '';
            const orderDtm = orderDtmMatch ? orderDtmMatch[1] : '';
            const patientName = ptntNmMatch[1];
            
            // 날짜 형식 변환 (YYYYMMDD -> YYYY-MM-DD)
            let receiptDate = '';
            let receiptTime = '';
            if (orderDt) {
                const year = orderDt.substring(0, 4);
                const month = orderDt.substring(4, 6);
                const day = orderDt.substring(6, 8);
                receiptDate = `${year}-${month}-${day}`;
            }
            
            if (orderDtm) {
                const year = orderDtm.substring(0, 4);
                const month = orderDtm.substring(4, 6);
                const day = orderDtm.substring(6, 8);
                const hour = orderDtm.substring(8, 10);
                const minute = orderDtm.substring(10, 12);
                const second = orderDtm.substring(12, 14);
                receiptTime = `${year}-${month}-${day} ${hour}:${minute}:${second}`;
            } else {
                // 파일 생성 시간 사용
                const stats = fs.statSync(filePath);
                receiptTime = moment(stats.birthtime).format('YYYY-MM-DD HH:mm:ss');
            }
            
            // MedItem 태그들을 찾아서 약물 정보 추출
            const medItemMatches = content.match(/<MedItem>([\s\S]*?)<\/MedItem>/g);
            const medicines = [];
            
            if (medItemMatches) {
                medItemMatches.forEach((medItem, index) => {
                    const codeMatch = medItem.match(/<Code>([^<]+)<\/Code>/);
                    const medNmMatch = medItem.match(/<MedNm>([^<]+)<\/MedNm>/);
                    const takeDaysMatch = medItem.match(/<TakeDays>([^<]+)<\/TakeDays>/);
                    const doseMatch = medItem.match(/<Dose>([^<]+)<\/Dose>/);
                    const dayTakeCntMatch = medItem.match(/<DayTakeCnt>([^<]+)<\/DayTakeCnt>/);
                    
                    if (codeMatch && medNmMatch && takeDaysMatch && doseMatch && dayTakeCntMatch) {
                        const pill_code = codeMatch[1];
                        const pill_name = medNmMatch[1];
                        const period = parseInt(takeDaysMatch[1]);
                        const volume = parseFloat(doseMatch[1]);
                        const daily = parseInt(dayTakeCntMatch[1]);
                        const total = Math.round(volume * daily * period); // 총량 계산
                        
                        medicines.push({
                            pill_code: pill_code,
                            pill_name: pill_name,
                            volume: volume,
                            daily: daily,
                            period: period,
                            total: total,
                            date: receiptDate,
                            line_number: index + 1
                        });
                    }
                });
            }
            
            parsedPrescriptions[receiptNumber] = {
                patient: {
                    name: patientName,
                    receipt_time: receiptTime,
                    receipt_date: receiptDate,
                    receipt_number: receiptNumber,
                    parsed_at: moment().format('YYYY-MM-DD HH:mm:ss')
                },
                medicines: medicines
            };
            
            parsedFiles.add(filePath);
            saveParsedFiles(); // parsedFiles 저장
            return receiptNumber;
        }
        
        // 자동 조제 트리거는 처방전 모니터링에서 처리하도록 변경
        // 여기서는 즉시 startDispensing을 호출하지 않음
    } catch (error) {
        logMessage(`파일 처방전연동 중 오류: ${error.message}`);
    }
    return null;
}

// 환자 필터링
function filterPatientsByDate() {
    let selectedDate = elements.datePicker.value;
    if (!selectedDate) {
        selectedDate = moment().format('YYYY-MM-DD');
        elements.datePicker.value = selectedDate;
    }
    logMessage(`날짜 필터링 시작: 선택된 날짜 = ${selectedDate}`);
    
    elements.patientTableBody.innerHTML = '';
    
    // 해당 날짜의 처방전들을 최신 순으로 정렬
    const prescriptionsForDate = Object.values(parsedPrescriptions)
        .filter(prescription => prescription.patient.receipt_date === selectedDate)
        .sort((a, b) => {
            // receipt_time을 기준으로 내림차순 정렬 (최신이 위로)
            return b.patient.receipt_time.localeCompare(a.patient.receipt_time);
        });
    
    let foundCount = 0;
    prescriptionsForDate.forEach(prescription => {
        logMessage(`확인 중: ${prescription.patient.receipt_number} (날짜: ${prescription.patient.receipt_time})`);
        
        const row = document.createElement('tr');
        
        // 기존에 저장된 환자 전송상태 확인
        const existingStatus = transmissionStatus[prescription.patient.receipt_number];
        
        // 해당 환자의 모든 약물 상태 확인하여 전체 상태 계산
        const medicineStatuses = prescription.medicines.map(medicine => {
            const key = getMedicineStatusKey(prescription.patient.receipt_number, medicine);
            return medicineTransmissionStatus[key] || 0;
        });
        
        // 전체 상태 결정 - 약물들의 최대 전송횟수를 반영
        let overallStatus = 0;
        
        // 등록된 약물들만 필터링하여 상태 확인
        const registeredMedicineStatuses = prescription.medicines
            .filter(medicine => isMedicineRegistered(medicine))
            .map(medicine => {
                const key = getMedicineStatusKey(prescription.patient.receipt_number, medicine);
                return medicineTransmissionStatus[key] || 0;
            });
        
        if (registeredMedicineStatuses.length === 0) {
            // 등록된 약물이 없는 경우
            overallStatus = 0;
        } else {
            // 등록된 약물들의 최대 전송횟수를 환자 전체 상태로 설정
            const numericStatuses = registeredMedicineStatuses.filter(s => typeof s === 'number');
            if (numericStatuses.length > 0) {
                const maxCount = Math.max(...numericStatuses);
                overallStatus = maxCount;
            } else {
                // 숫자가 아닌 상태들만 있는 경우 (예: "등록되지 않은 약물")
                overallStatus = 0;
            }
        }
        
        // 전송상태 저장
        transmissionStatus[prescription.patient.receipt_number] = overallStatus;
        
        const badgeClass = getStatusBadgeClass(overallStatus);
        const statusText = getStatusText(overallStatus);
        const statusBadge = `<span class="badge ${badgeClass}">${statusText}</span>`;
        
        row.innerHTML = `
            <td>${prescription.patient.name}</td>
            <td>${prescription.patient.receipt_time}</td>
            <td>${prescription.patient.receipt_number}</td>
            <td>${statusBadge}</td>
        `;
        row.setAttribute('data-receipt-number', prescription.patient.receipt_number);
        elements.patientTableBody.appendChild(row);
        foundCount++;
        logMessage(`환자 추가: ${prescription.patient.name} (${prescription.patient.receipt_number}) - 상태: ${overallStatus}`);
    });
    
    // 빈 행 추가하여 5줄 고정
    const emptyRowsNeeded = 5 - foundCount;
    for (let i = 0; i < emptyRowsNeeded; i++) {
        const emptyRow = document.createElement('tr');
        emptyRow.innerHTML = `
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
        `;
        emptyRow.classList.add('empty-row');
        elements.patientTableBody.appendChild(emptyRow);
    }
    
    logMessage(`날짜 필터링 완료: ${foundCount}명의 환자 발견 (최신 순 정렬)`);
}

// 환자 약물 정보 로드
function loadPatientMedicines(receiptNumber) {
    const prescription = parsedPrescriptions[receiptNumber];
    
    elements.medicineTableBody.innerHTML = '';
    
    if (prescription) {
        prescription.medicines.forEach(medicine => {
            const row = document.createElement('tr');
            
            // 약물이 저장된 시럽조제기에 등록되어 있는지 확인
            const isRegistered = isMedicineRegistered(medicine);
            
            const key = getMedicineStatusKey(receiptNumber, medicine);
            let savedStatus = medicineTransmissionStatus[key];
            
            // 등록되지 않은 약물은 "등록되지 않은 약물" 상태로 설정
            if (!isRegistered) {
                savedStatus = '등록되지 않은 약물';
                medicineTransmissionStatus[key] = savedStatus;
            }
            
            let statusBadge = '<span class="badge bg-secondary">0</span>';
            
            if (savedStatus !== undefined) {
                const badgeClass = getStatusBadgeClass(savedStatus);
                const statusText = getStatusText(savedStatus);
                statusBadge = `<span class="badge ${badgeClass}">${statusText}</span>`;
            }
            
            const matchId = getMedicineMatchId(medicine);
            const isChecked = isRegistered;
            const isDisabled = !isRegistered;
            
            row.innerHTML = `
                <td>
                    <input type="checkbox" 
                           class="medicine-checkbox" 
                           data-pill-code="${matchId}"
                           data-pill-name="${medicine.pill_name}"
                           data-total="${medicine.total}"
                           ${isChecked ? 'checked' : ''}
                           ${isDisabled ? 'disabled' : ''}>
                </td>
                <td>${medicine.pill_name}</td>
                <td>${prescriptionParseMode === 'pdf_bag' ? '-' : medicine.pill_code}</td>
                <td>${medicine.volume}</td>
                <td>${medicine.daily}</td>
                <td>${medicine.period}</td>
                <td>${medicine.total}</td>
                <td>${statusBadge}</td>
            `;
            row.dataset.pillCode = matchId;
            row.dataset.isRegistered = isRegistered;
            elements.medicineTableBody.appendChild(row);
        });
        
        updateMedicineColors();
    }
    
    // 빈 행 추가하여 5줄 고정
    const currentRows = elements.medicineTableBody.querySelectorAll('tr:not(.empty-row)').length;
    const emptyRowsNeeded = 5 - currentRows;
    for (let i = 0; i < emptyRowsNeeded; i++) {
        const emptyRow = document.createElement('tr');
        emptyRow.innerHTML = `
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
        `;
        emptyRow.classList.add('empty-row');
        elements.medicineTableBody.appendChild(emptyRow);
    }
    
    // 행 색상 업데이트
    updateMedicineRowColors();
    
    // 전체 선택 체크박스 상태 업데이트
    updateMedicineSelectAllCheckbox();
    
    // 환자 테이블의 전송상태 업데이트 (약물 정보 변경 시 자동 반영)
    updatePatientTransmissionStatus(receiptNumber);
}

// 전체 선택 체크박스 토글
function toggleAllMedicineSelections() {
    const selectAllCheckbox = document.getElementById('selectAllMedicineCheckbox');
    const checkboxes = document.querySelectorAll('.medicine-checkbox:not(:disabled)');
    
    checkboxes.forEach(checkbox => {
        checkbox.checked = selectAllCheckbox.checked;
    });
}

// 전체 선택 체크박스 상태 업데이트
function updateMedicineSelectAllCheckbox() {
    const selectAllCheckbox = document.getElementById('selectAllMedicineCheckbox');
    if (!selectAllCheckbox) return;
    
    const checkboxes = document.querySelectorAll('.medicine-checkbox:not(:disabled)');
    const checkedBoxes = document.querySelectorAll('.medicine-checkbox:not(:disabled):checked');
    
    if (checkedBoxes.length === 0) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
    } else if (checkedBoxes.length === checkboxes.length) {
        selectAllCheckbox.checked = true;
        selectAllCheckbox.indeterminate = false;
    } else {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = true;
    }
}

// 약물 색상 업데이트
function updateMedicineColors() {
    console.log('=== 약물 색상 업데이트 시작 ===');
    console.log('연결된 기기들:', connectedDevices);
    
    const rows = elements.medicineTableBody.querySelectorAll('tr:not(.empty-row)');
    console.log(`약물 정보 행 수: ${rows.length}`);
    
    rows.forEach((row, index) => {
        const pillCode = row.dataset.pillCode;
        const isRegistered = row.dataset.isRegistered === 'true';
        console.log(`행 ${index + 1}: 약품 코드 = ${pillCode}, 등록됨 = ${isRegistered}`);
        
        if (!pillCode) {
            console.log(`행 ${index + 1}: 약품 코드 없음, 건너뛰기`);
            return; // 약품 코드가 없는 행은 건너뛰기
        }
        
        // 기존 클래스 제거
        row.classList.remove('connected', 'disconnected', 'unregistered');
        console.log(`행 ${index + 1}: 기존 클래스 제거됨`);
        
        // 등록되지 않은 약물은 검정색으로 표시
        if (!isRegistered) {
            row.classList.add('unregistered');
            console.log(`행 ${index + 1}: unregistered 클래스 추가 (검정색)`);
        } else {
            let isConnected = false;
            
            // 연결된 기기들 중에서 해당 약품 코드와 일치하는 기기가 있는지 확인
            Object.values(connectedDevices).forEach(device => {
                console.log(`기기 확인: ${device.nickname} vs ${pillCode} (상태: ${device.status})`);
                if (deviceMatchesMedicineId(device, pillCode) && device.status === '연결됨') {
                    isConnected = true;
                    console.log(`일치 발견: ${device.nickname}`);
                }
            });
            
            // 연결 상태에 따라 클래스 추가
            if (isConnected) {
                row.classList.add('connected');
                console.log(`행 ${index + 1}: connected 클래스 추가 (파란색)`);
            } else {
                row.classList.add('disconnected');
                console.log(`행 ${index + 1}: disconnected 클래스 추가 (빨간색)`);
            }
        }
        
        // 현재 클래스 확인
        console.log(`행 ${index + 1}: 현재 클래스 = ${row.className}`);
    });
    
    console.log('=== 약물 색상 업데이트 완료 ===');
}

// 대기열에서 다음 처방전 처리
function processNextInQueue() {
    if (autoDispensingQueue.length === 0) {
        return; // 대기열이 비어있으면 종료
    }
    
    if (isAutoDispensingInProgress) {
        return; // 이미 조제가 진행 중이면 대기
    }
    
    // 플래그를 즉시 설정하여 중복 실행 방지 (경쟁 조건 방지)
    isAutoDispensingInProgress = true;
    
    const receiptNumber = autoDispensingQueue.shift(); // 대기열에서 첫 번째 항목 제거
    const prescription = parsedPrescriptions[receiptNumber];
    
    if (!prescription) {
        logMessage(`대기열에서 처방전을 찾을 수 없음: ${receiptNumber}`);
        // 플래그 해제 후 다음 항목 처리
        isAutoDispensingInProgress = false;
        processNextInQueue();
        return;
    }
    
    logMessage(`대기열에서 처방전 처리 시작: ${receiptNumber} (대기 중인 처방전: ${autoDispensingQueue.length}개)`);
    
    // 환자 행 찾기 및 선택 (지연 최소화)
    const row = document.querySelector(`#patientTableBody tr[data-receipt-number="${receiptNumber}"]`);
    if (row) {
        // 기존 선택 해제
        document.querySelectorAll('#patientTableBody tr').forEach(r => r.classList.remove('table-primary'));
        row.classList.add('table-primary');
        
        // 약물 정보 로드
        loadPatientMedicines(receiptNumber);
        logMessage(`자동조제: 환자 ${prescription.patient.name} 선택 및 약물 정보 로드 완료`);
        
        // 약물 정보 로드 후 즉시 조제 시작 (DOM 업데이트를 위한 최소 지연)
        // 백그라운드에서도 작동하도록 setTimeout 사용 (requestAnimationFrame은 백그라운드에서 일시정지됨)
        setTimeout(() => {
            logMessage(`조제를 시작합니다. 환자: ${prescription.patient.name}`);
            startDispensingInternal(receiptNumber, true); // true: 자동조제 플래그
        }, 0);
    } else {
        logMessage(`환자 행을 찾을 수 없음: ${receiptNumber}`);
        // 플래그 해제 후 다음 항목 처리
        isAutoDispensingInProgress = false;
        processNextInQueue();
    }
}

// 조제 시작
async function startDispensing(isAuto = false) {
    // 자동조제 중복 실행 방지
    if (isAuto && isAutoDispensingInProgress) {
        logMessage('자동조제가 이미 진행 중입니다. 중복 실행을 방지합니다.');
        return;
    }
    
    let selectedPatient = document.querySelector('#patientTableBody tr.table-primary');
    if (!selectedPatient && isAuto) {
        // 자동조제 모드일 때는 오늘 날짜의 첫 번째 환자 자동 선택
        selectedPatient = document.querySelector('#patientTableBody tr');
        if (selectedPatient) {
            selectedPatient.classList.add('table-primary');
            // 자동조제 모드일 때는 약물 정보도 자동으로 로드
            const receiptNumber = selectedPatient.dataset.receiptNumber;
            if (receiptNumber) {
                loadPatientMedicines(receiptNumber);
                logMessage(`자동조제: 환자 ${receiptNumber} 선택 및 약물 정보 로드 완료`);
                
                // 자동조제 진행 중 플래그 설정
                isAutoDispensingInProgress = true;
                
                // 약물 정보 로드 후 즉시 조제 시작 (DOM 업데이트를 위한 최소 지연)
                // 백그라운드에서도 작동하도록 setTimeout 사용 (requestAnimationFrame은 백그라운드에서 일시정지됨)
                setTimeout(() => {
                    startDispensingInternal(receiptNumber, isAuto);
                }, 0);
                return; // 여기서 함수 종료하고 내부 함수에서 계속 처리
            }
        }
    }
    if (!selectedPatient) {
        showMessage('warning', '환자를 선택해주세요.');
        return;
    }
    const receiptNumber = selectedPatient.dataset.receiptNumber;
    console.log('[startDispensing] receiptNumber:', receiptNumber, 'isAuto:', isAuto);
    
    // 내부 조제 함수 호출
    startDispensingInternal(receiptNumber, isAuto);
}

// 실제 조제 로직을 처리하는 내부 함수
async function startDispensingInternal(receiptNumber, isAuto = false) {
    const prescription = parsedPrescriptions[receiptNumber];
    if (!prescription) {
        showMessage('error', '처방전 정보를 찾을 수 없습니다.');
        // 자동조제 흐름이 비정상 종료될 때 대기열 진행이 멈추지 않도록 복구
        isDispensingInProgress = false;
        if (isAuto) {
            isAutoDispensingInProgress = false;
            processNextInQueue();
        }
        return;
    }
    
    if (Object.keys(connectedDevices).length === 0) {
        showMessage('warning', '연결된 시럽조제기가 없습니다.');
        // 연결된 기기가 없을 때 플래그와 연결 확인 주기를 원복하고 다음 항목 처리
        isDispensingInProgress = false;
        dispensingDevices.clear();
        cancelConnectionCheckDelay();
        setNormalConnectionCheck();
        if (isAuto) {
            isAutoDispensingInProgress = false;
            processNextInQueue();
        }
        return;
    }
    
    logMessage(`조제를 시작합니다. 환자: ${prescription.patient.name}`);
    
    // 조제 시작 시 연결 상태 확인을 느린 모드로 전환
    setSlowConnectionCheck();
    
    // 조제 진행 중 플래그 설정 및 연결 상태 확인 지연 시작
    isDispensingInProgress = true;
    dispensingDevices.clear(); // 조제 중인 기기 목록 초기화
    startConnectionCheckDelay(5); // 5초 동안 연결 상태 확인 지연
    
    // 자동조제 모드일 때는 모든 등록된 약물을 자동으로 선택
    if (isAuto) {
        prescription.medicines.forEach(medicine => {
            const checkbox = document.querySelector(`.medicine-checkbox[data-pill-code="${getMedicineMatchId(medicine)}"]`);
            if (checkbox && !checkbox.disabled) {
                checkbox.checked = true;
            }
        });
        logMessage('자동조제: 모든 등록된 약물을 자동으로 선택했습니다.');
    }
    
    // 선택된 약물들만 필터링
    const selectedMedicines = prescription.medicines.filter(medicine => {
        const checkbox = document.querySelector(`.medicine-checkbox[data-pill-code="${getMedicineMatchId(medicine)}"]`);
        return checkbox && checkbox.checked;
    });
    
    if (selectedMedicines.length === 0) {
        if (isAuto) {
            logMessage('자동조제: 선택 가능한 약물이 없습니다. (모든 약물이 등록되지 않았거나 연결되지 않음)');
            // 자동조제에서 선택 약물이 없을 때 플래그 원복 및 다음 처방전 진행
            isDispensingInProgress = false;
            dispensingDevices.clear();
            cancelConnectionCheckDelay();
            setNormalConnectionCheck();
            isAutoDispensingInProgress = false;
            processNextInQueue();
            return;
        } else {
            showMessage('warning', '전송할 약물을 선택해주세요.');
            // 수동 조제에서도 진행 플래그와 연결 확인 주기를 복구
            isDispensingInProgress = false;
            dispensingDevices.clear();
            cancelConnectionCheckDelay();
            setNormalConnectionCheck();
            return;
        }
    }
    
    // 등록된 약물들만 필터링 (저장된 시럽조제기에 등록된 약물만)
    const registeredMedicines = selectedMedicines.filter(medicine => {
        return isMedicineRegistered(medicine);
    });
    
    const unregisteredMedicines = selectedMedicines.filter(medicine => {
        return !isMedicineRegistered(medicine);
    });
    
    // 등록되지 않은 약물들을 "등록되지 않은 약물" 상태로 표시
    for (const medicine of unregisteredMedicines) {
        logMessage(`${medicine.pill_name}은(는) 저장된 시럽조제기에 등록되지 않은 약물이므로 전송에서 제외됩니다.`);
        await updateMedicineTransmissionStatus(receiptNumber, getMedicineMatchId(medicine), '등록되지 않은 약물');
    }

    // 시럽 최대량 초과 검증
    const overLimitMedicines = registeredMedicines.filter(medicine => {
        return medicine.total > maxSyrupAmount;
    });

    const validMedicines = registeredMedicines.filter(medicine => {
        return medicine.total <= maxSyrupAmount;
    });

    // 최대량을 초과하는 약물들을 실패 상태로 표시
    if (overLimitMedicines.length > 0) {
        const overLimitNames = overLimitMedicines.map(m => `${m.pill_name}(${m.total}mL)`).join('\n• ');
        for (const medicine of overLimitMedicines) {
            logMessage(`${medicine.pill_name}은(는) 총량 ${medicine.total}mL가 설정된 최대량 ${maxSyrupAmount}mL를 초과하므로 전송에서 제외됩니다.`);
            // 팝업 대신 전송 상태에 표시
            await updateMedicineTransmissionStatus(receiptNumber, getMedicineMatchId(medicine), '최대량 초과');
        }
    }
    
    // 연결된 약물들만 필터링 (유효한 약물 중에서 연결된 것만)
    const connectedMedicines = validMedicines.filter(medicine => {
        const connectedDevice = findConnectedDeviceForMedicine(medicine, true);
        if (!connectedDevice) {
            const deviceWithMatch = findConnectedDeviceForMedicine(medicine, false);
            if (deviceWithMatch) {
                logMessage(`약물 ${medicine.pill_name} - 기기 상태: ${deviceWithMatch.status}`);
            } else {
                logMessage(`약물 ${medicine.pill_name} - connectedDevices에서 찾을 수 없음`);
            }
        }
        return connectedDevice !== undefined;
    });
    
    const notConnectedMedicines = validMedicines.filter(medicine => {
        return !findConnectedDeviceForMedicine(medicine, true);
    });
    
    // 연결되지 않은 약물들을 실패 상태로 표시
    for (const medicine of notConnectedMedicines) {
        logMessage(`${medicine.pill_name}은(는) 연결되지 않은 약물이므로 건너뜁니다.`);
        await updateMedicineTransmissionStatus(receiptNumber, getMedicineMatchId(medicine), '실패');
    }
    
    if (connectedMedicines.length === 0) {
        // 등록되지 않은 약물이나 최대량 초과 약물만 있는 경우 팝업을 띄우지 않음
        const hasOnlyUnregisteredOrOverLimit = selectedMedicines.length > 0 && 
            unregisteredMedicines.length + overLimitMedicines.length === selectedMedicines.length;
        
        if (hasOnlyUnregisteredOrOverLimit) {
            // 등록되지 않은 약물이나 최대량 초과 약물만 있는 경우 조용히 처리
            logMessage('전송할 수 있는 약물이 없습니다. (등록되지 않은 약물 또는 최대량 초과 약물만 선택됨)');
        } else {
            // 다른 이유로 전송할 수 없는 경우에만 팝업 표시
            showMessage('warning', '전송할 수 있는 약물이 없습니다.');
        }
        
        // 자동조제 큐를 막지 않도록 플래그 및 상태를 복구 후 다음 처방전 처리
        isDispensingInProgress = false;
        dispensingDevices.clear();
        cancelConnectionCheckDelay();
        setNormalConnectionCheck();
        if (isAuto) {
            isAutoDispensingInProgress = false;
            processNextInQueue();
        }
        return;
    }
    
    logMessage(`병렬 전송 시작: ${connectedMedicines.length}개 약물`);
    
    // 과도한 동시 요청을 줄이기 위해 약물별로 소량의 지연을 둡니다.
    const wait = (ms) => new Promise(res => setTimeout(res, ms));
    const dispenseStaggerMs = 200; // 약물별 시작 간격 (ms)
    
    // 모든 약물을 병렬로 전송하되, 시작 시점을 약간씩 지연
    const dispensingPromises = connectedMedicines.map(async (medicine, index) => {
        if (index > 0) {
            await wait(dispenseStaggerMs * index);
        }
        const connectedDevice = findConnectedDeviceForMedicine(medicine, true);
        
        logMessage(`병렬 전송 시작: ${medicine.pill_name}, 총량: ${medicine.total}`);
        
        // 조제 중에도 ESP32는 듀얼코어로 통신 가능하므로 상태는 "연결됨" 유지
        dispensingDevices.add(connectedDevice.ip); // 조제 중인 기기 목록에 추가 (연결 상태 확인 시 참고용)
        logMessage(`${medicine.pill_name} 조제 시작 - 기기 상태는 '연결됨' 유지`);
        
        // 약물 전송상태는 변경하지 않음 (전송 결과에 따라만 변경)
        
        try {
            const data = {
                patient_name: prescription.patient.name,
                total_volume: medicine.total
            };
            
            // 요청 재시도(404/Network Error/timeout 포함)
            const maxAttempts = 5;
            let lastError = null;
            let response = null;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    response = await makeStableRequest(`http://${connectedDevice.ip}/dispense`, data, {
                        timeout: COMMUNICATION_CONFIG.TIMEOUTS.DISPENSE
                    });
                    break; // 성공
                } catch (err) {
                    lastError = err;
                    const isLast = attempt === maxAttempts;
                    const status = err.response && err.response.status;
                    const isRetryable = status === 404 || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH' || err.code === 'ECONNRESET' || err.message.includes('Network Error');
                    if (!isRetryable || isLast) {
                        throw err;
                    }
                    logMessage(`${medicine.pill_name} 전송 재시도 (${attempt}/${maxAttempts - 1}) - 오류: ${err.message}`);
                    const backoff = Math.min(500 * Math.pow(2, attempt - 1), 3000); // 최대 3초
                    await wait(backoff);
                }
            }
            
            if (response && response.status === 200) {
                logMessage(`${medicine.pill_name} 응답 데이터: ${JSON.stringify(response.data)}`);
                
                // 모든 200 응답(BUSY 포함)을 성공으로 처리
                const key = getMedicineStatusKey(receiptNumber, medicine);
                const currentStatus = medicineTransmissionStatus[key] || 0;
                const newStatus = incrementTransmissionCount(currentStatus);
                
                if (response.data === "BUSY") {
                    logMessage(`${medicine.pill_name} 조제 중 - 대기열에 추가됨 (성공으로 처리)`);
                    await updateMedicineTransmissionStatus(receiptNumber, getMedicineMatchId(medicine), newStatus);
                    return { success: true, medicine: medicine, device: connectedDevice, status: 'success' };
                } else {
                    logMessage(`${medicine.pill_name} 데이터 전송 성공 (응답: ${response.data})`);
                    await updateMedicineTransmissionStatus(receiptNumber, getMedicineMatchId(medicine), newStatus);
                    return { success: true, medicine: medicine, device: connectedDevice, status: 'success' };
                }
            } else {
                throw new Error(`HTTP ${response ? response.status : 'No Response'}`);
            }
        } catch (error) {
            logMessage(`${medicine.pill_name} 전송 실패: ${error.message}`);
            await updateMedicineTransmissionStatus(receiptNumber, getMedicineMatchId(medicine), 0); // 실패는 0으로 표시
            
            // 조제 실패 시에도 기기 상태는 "연결됨" 유지 (ESP32는 듀얼코어로 통신 가능)
            dispensingDevices.delete(connectedDevice.ip); // 조제 중인 기기 목록에서 제거
            
            return { success: false, medicine: medicine, device: connectedDevice, error: error.message };
        }
    });
    
    try {
        const results = await Promise.allSettled(dispensingPromises);
        
        // 모든 조제 완료 후 처리
        let successCount = 0;
        let failureCount = 0;
        
        logMessage(`=== 조제 결과 분석 시작 ===`);
        for (let index = 0; index < results.length; index++) {
            const result = results[index];
            const medicine = connectedMedicines[index];
            logMessage(`약물 ${medicine.pill_name} 결과: ${result.status} - ${JSON.stringify(result.value || result.reason)}`);
            
            if (result.status === 'fulfilled' && result.value && result.value.success) {
                const { device, status } = result.value;
                
                // 조제 완료 - 기기 상태는 "연결됨" 유지 (변경 불필요)
                dispensingDevices.delete(device.ip); // 조제 중인 기기 목록에서 제거
                
                logMessage(`${medicine.pill_name} 데이터 전송 완료`);
            } else {
                const device = findConnectedDeviceForMedicine(medicine, false);
                if (device) {
                    dispensingDevices.delete(device.ip); // 조제 중인 기기 목록에서 제거
                    // 실패한 경우에도 기기 상태는 "연결됨" 유지 (ESP32는 듀얼코어로 통신 가능)
                    // 연결 끊김 상태인 경우에만 복구
                    if (device.status === '연결 끊김') {
                        device.status = '연결됨';
                        updateConnectedTable();
                    }
                }
                
                // 실패한 약물 상태 업데이트
                await updateMedicineTransmissionStatus(receiptNumber, getMedicineMatchId(medicine), 0); // 실패는 0으로 표시
                logMessage(`${medicine.pill_name} 조제 실패`);
            }
        }
        
        // 조제 완료 후 연결 상태 확인 재개
        if (dispensingDevices.size === 0) {
            isDispensingInProgress = false;
            isAutoDispensingInProgress = false; // 자동조제 플래그 해제
            cancelConnectionCheckDelay(); // 지연 타이머 취소
            setNormalConnectionCheck(); // 일반 모드로 전환
            logMessage('모든 조제 완료 - 일반 연결 상태 확인 모드로 전환');
            
            // 대기열에서 다음 처방전 처리
            processNextInQueue();
        }
        
        // 조제 완료 로그 출력
        logMessage(`조제 작업이 완료되었습니다.`);
        
    } catch (error) {
        logMessage(`조제 중 오류 발생: ${error.message}`);
        isAutoDispensingInProgress = false; // 오류 발생 시에도 자동조제 플래그 해제
        
        // 오류 발생 시에도 조제 중인 기기들을 정리
        dispensingDevices.clear();
        isDispensingInProgress = false;
        
        // 오류 발생 시에도 대기열에서 다음 처방전 처리
        processNextInQueue();
        cancelConnectionCheckDelay();
        setNormalConnectionCheck(); // 일반 모드로 복구
    }
}

// 전송 상태 업데이트
async function updateTransmissionStatus(receiptNumber, status) {
    console.log('[updateTransmissionStatus] 호출됨:', receiptNumber, status);
    
    // 전역 변수에 상태 저장
    transmissionStatus[receiptNumber] = status;
    
    // 파일에 저장
    await saveTransmissionStatus();
    
    const row = document.querySelector(`#patientTableBody tr[data-receipt-number="${receiptNumber}"]`);
    if (row) {
        const statusCell = row.cells[3];
        const badgeClass = status === '완료' ? 'bg-success' : 'bg-danger';
        statusCell.innerHTML = `<span class="badge ${badgeClass}">${status}</span>`;
        console.log('[updateTransmissionStatus] 상태 업데이트 성공:', receiptNumber, status);
    } else {
        console.error('[updateTransmissionStatus] 환자 행을 찾을 수 없음:', receiptNumber);
        console.log('[updateTransmissionStatus] 현재 환자 테이블 행들:');
        document.querySelectorAll('#patientTableBody tr').forEach((r, index) => {
            console.log(`  행 ${index}: data-receipt-number="${r.dataset.receiptNumber}"`);
        });
    }
}

// 선택된 약물 삭제
function deleteSelectedMedicine() {
    const selectedRows = elements.medicineTableBody.querySelectorAll('tr.table-primary');
    if (selectedRows.length === 0) {
        showMessage('warning', '삭제할 약물을 선택해주세요.');
        return;
    }
    
    selectedRows.forEach(row => {
        const medicineName = row.cells[0].textContent;
        row.remove();
        logMessage(`약물 '${medicineName}'이(가) 삭제되었습니다.`);
    });
    
    showMessage('info', '선택된 약물이 삭제되었습니다.');
}

// 메시지 표시 함수 보정
async function showMessage(type, message) {
    // Electron에서 허용하는 타입만 사용
    const validTypes = ['info', 'warning', 'error', 'question'];
    if (type === 'success') type = 'info';
    if (!validTypes.includes(type)) type = 'info';
    await ipcRenderer.invoke('show-message', { type, message });
}

// 초기 연결 시도 (앱 시작 시 저장된 기기들 연결)
async function attemptInitialConnection() {
    logMessage('초기 연결 시도 시작...');
    
    // 연결할 기기 목록 생성
    const devicesToConnect = [];
    for (const [savedMac, info] of Object.entries(savedConnections)) {
        // 수동으로 연결을 끊은 기기는 제외
        if (manuallyDisconnectedDevices.has(savedMac)) {
            logMessage(`초기 연결에서 제외 (수동 해제): ${info.nickname}`);
            continue;
        }
        
        // 이미 연결된 기기는 제외
        if (connectedDevices[savedMac]) {
            logMessage(`이미 연결됨: ${info.nickname}`);
            continue;
        }
        
        devicesToConnect.push({ mac: savedMac, info: info });
    }
    
    // 모든 기기를 병렬로 연결 시도
    const connectionPromises = devicesToConnect.map(async ({ mac, info }) => {
        logMessage(`초기 연결 시도: ${info.nickname} (${info.ip})`);
        
        try {
            const success = await connectToDeviceByMac(mac, true);
            if (success) {
                logMessage(`초기 연결 성공: ${info.nickname}`);
            } else {
                logMessage(`초기 연결 실패: ${info.nickname}`);
            }
            return { mac, success };
        } catch (error) {
            logMessage(`초기 연결 오류: ${info.nickname} - ${error.message}`);
            return { mac, success: false };
        }
    });
    
    // 모든 연결 시도 완료 대기
    const results = await Promise.allSettled(connectionPromises);
    
    // 결과 요약
    const successfulConnections = results.filter(result => 
        result.status === 'fulfilled' && result.value.success
    ).length;
    
    logMessage(`초기 연결 시도 완료: ${successfulConnections}/${devicesToConnect.length}개 성공`);
}

// 일괄 연결 (등록된 모든 기기 연결 시도)
async function connectAllDevices() {
    logMessage('일괄 연결 시작...');
    
    // 연결할 기기 목록 생성 (수동 해제된 기기도 포함)
    const devicesToConnect = [];
    for (const [savedMac, info] of Object.entries(savedConnections)) {
        // 이미 연결된 기기는 제외
        if (connectedDevices[savedMac]) {
            logMessage(`이미 연결됨: ${info.nickname}`);
            continue;
        }
        
        devicesToConnect.push({ mac: savedMac, info: info });
    }
    
    if (devicesToConnect.length === 0) {
        showMessage('info', '연결할 기기가 없습니다.');
        logMessage('일괄 연결: 연결할 기기가 없습니다.');
        return;
    }
    
    // 수동 해제 목록에서 제거 (사용자가 일괄연결을 누른 것은 다시 연결하고 싶다는 의미)
    devicesToConnect.forEach(({ mac }) => {
        if (manuallyDisconnectedDevices.has(mac)) {
            manuallyDisconnectedDevices.delete(mac);
            logMessage(`수동 해제 목록에서 제거: ${savedConnections[mac].nickname}`);
        }
    });
    
    // 수동 해제 목록 변경사항 저장
    await saveConnections();
    
    // 모든 기기를 병렬로 연결 시도
    const connectionPromises = devicesToConnect.map(async ({ mac, info }) => {
        logMessage(`일괄 연결 시도: ${info.nickname} (${info.ip})`);
        
        try {
            const success = await connectToDeviceByMac(mac, false);
            if (success) {
                logMessage(`일괄 연결 성공: ${info.nickname}`);
            } else {
                logMessage(`일괄 연결 실패: ${info.nickname}`);
            }
            return { mac, success };
        } catch (error) {
            logMessage(`일괄 연결 오류: ${info.nickname} - ${error.message}`);
            return { mac, success: false };
        }
    });
    
    // 모든 연결 시도 완료 대기
    const results = await Promise.allSettled(connectionPromises);
    
    // 결과 요약
    const successfulConnections = results.filter(result => 
        result.status === 'fulfilled' && result.value.success
    ).length;
    
    const message = `일괄 연결 완료: ${successfulConnections}/${devicesToConnect.length}개 성공`;
    logMessage(message);
    showMessage('info', message);
}

// 주기적 작업 시작
function startPeriodicTasks() {
    // 주기적 스캔 시작
    scheduleScan();
    
    // 초기에는 빠른 연결 상태 확인 시작
    setFastConnectionCheck();
    
    logMessage('주기적 작업이 시작되었습니다.');
}

// 연결 상태 확인 시작
function startConnectionStatusCheck() {
    if (connectionCheckInterval) {
        clearInterval(connectionCheckInterval);
    }
    
    connectionCheckInterval = setInterval(checkConnectionStatus, connectionCheckIntervalMs);
    logMessage(`연결 상태 확인 시작 (주기: ${connectionCheckIntervalMs/1000}초)`);
}

// 연결 상태 확인 주기 조정
function adjustConnectionCheckInterval(newIntervalMs) {
    connectionCheckIntervalMs = newIntervalMs;
    
    if (connectionCheckInterval) {
        clearInterval(connectionCheckInterval);
        connectionCheckInterval = setInterval(checkConnectionStatus, connectionCheckIntervalMs);
        logMessage(`연결 상태 확인 주기 조정: ${connectionCheckIntervalMs/1000}초`);
    }
}

// 빠른 연결 상태 확인 (초기 연결 시)
function setFastConnectionCheck() {
    adjustConnectionCheckInterval(5000); // 5초
    logMessage('빠른 연결 상태 확인 모드 활성화 (5초 주기)');
}

// 일반 연결 상태 확인 (기본)
function setNormalConnectionCheck() {
    adjustConnectionCheckInterval(15000); // 15초
    logMessage('일반 연결 상태 확인 모드 활성화 (15초 주기)');
}

// 느린 연결 상태 확인 (조제 중)
function setSlowConnectionCheck() {
    adjustConnectionCheckInterval(60000); // 60초
    logMessage('느린 연결 상태 확인 모드 활성화 (60초 주기)');
}

// 연결 상태 즉시 새로고침 (사용자 요청)
async function refreshConnectionStatus() {
    logMessage('사용자 요청으로 연결 상태 새로고침 시작...');
    
    // 조제 진행 중이면 새로고침 건너뛰기
    if (isDispensingInProgress) {
        await showMessage('warning', '조제 진행 중에는 연결 상태를 확인할 수 없습니다.');
        return;
    }
    
    // 조제 중인 기기가 있는지 확인
    if (dispensingDevices.size > 0) {
        await showMessage('warning', '조제 중인 기기가 있어 연결 상태를 확인할 수 없습니다.');
        return;
    }
    
    // 기존 연결 상태 확인 중단
    if (connectionCheckInterval) {
        clearInterval(connectionCheckInterval);
        connectionCheckInterval = null;
    }
    
    // 즉시 연결 상태 확인 실행
    await checkConnectionStatus();
    
    // 연결 상태 확인 재시작
    if (connectionCheckIntervalMs) {
        connectionCheckInterval = setInterval(checkConnectionStatus, connectionCheckIntervalMs);
        logMessage(`연결 상태 확인 재시작 (주기: ${connectionCheckIntervalMs/1000}초)`);
    }
    
    logMessage('연결 상태 새로고침 완료');
}

// 연결 상태 확인 (arduino_connector.py 방식 적용)
async function checkConnectionStatus() {
    if (isCheckingStatus) {
        return; // 이미 확인 중이면 중복 실행 방지
    }
    
    // 조제 진행 중이면 연결 상태 확인을 완전히 건너뛰기
    if (isDispensingInProgress) {
        logMessage('조제 진행 중 - 연결 상태 확인 건너뜀');
        return;
    }
    
    // 조제 중인 기기가 있는지 확인
    if (dispensingDevices.size > 0) {
        logMessage(`조제 중인 기기 존재 (${dispensingDevices.size}개) - 연결 상태 확인 건너뜀`);
        return;
    }
    
    try {
        isCheckingStatus = true;
        const rows = elements.connectedTableBody.querySelectorAll('tr');
        
        // MAC 주소 정규화 함수
        const normalizeMac = (macStr) => {
            return macStr.replace(/[:\-]/g, '').toUpperCase();
        };
        
        let allConnected = true;
        let hasConnectedDevices = false;
        
        for (const row of rows) {
            const cells = row.cells;
            const ip = cells[2].textContent;
            const currentStatus = cells[3].textContent.trim(); // 현재 상태 가져오기
            
            // 조제 중인 기기는 연결 상태 확인을 건너뛰기 (ESP32는 듀얼코어로 통신 가능하지만, 조제 중에는 상태 확인 불필요)
            if (dispensingDevices.has(ip)) {
                logMessage(`조제 중인 기기 연결 상태 확인 건너뜀: ${ip}`);
                continue;
            }
            
            let mac = null;
            for (const [deviceMac, deviceInfo] of Object.entries(connectedDevices)) {
                if (deviceInfo.ip === ip) {
                    mac = deviceMac;
                    break;
                }
            }
            
            hasConnectedDevices = true;
            
            try {
                // 일시적인 타임아웃에 대한 재시도 로직
                let response = null;
                let lastError = null;
                
                for (let retry = 0; retry < 2; retry++) {
                    try {
                        response = await axios.get(`http://${ip}`, { timeout: COMMUNICATION_CONFIG.TIMEOUTS.CONNECTION_CHECK });
                        break; // 성공하면 재시도 중단
                    } catch (error) {
                        lastError = error;
                        if (retry < 1 && (error.code === 'ECONNABORTED' || error.message.includes('timeout'))) {
                            logMessage(`연결 상태 확인 재시도: ${ip} - ${error.message}`);
                            await new Promise(resolve => setTimeout(resolve, 1000)); // 1초 대기
                        } else {
                            break; // 타임아웃이 아닌 오류는 재시도하지 않음
                        }
                    }
                }
                
                if (!response) {
                    throw lastError; // 모든 재시도 실패
                }
                
                if (response.status === 200) {
                    const data = response.data;
                    if (data.mac) {
                        // MAC 주소 정규화하여 비교
                        const normalizedDeviceMac = normalizeMac(data.mac);
                        const normalizedSavedMac = normalizeMac(mac);
                        
                        if (normalizedDeviceMac === normalizedSavedMac) {
                            // 조제 중이 아닌 경우에만 상태를 "연결됨"으로 변경
                            if (!dispensingDevices.has(ip)) {
                                updateDeviceStatus(ip, '연결됨');
                            }
                        } else {
                            // MAC 주소가 다르면 연결 해제
                            elements.connectedTableBody.removeChild(row);
                            delete connectedDevices[mac];
                            logMessage(`기기 MAC 주소 불일치로 연결 해제: ${ip} (기기=${data.mac}, 저장된=${mac})`);
                            allConnected = false;
                        }
                    } else {
                        // MAC 정보가 없어도 200 응답이면 연결됨 상태로 복구
                        // (ESP32가 MAC 정보를 반환하지 않는 경우가 있을 수 있음)
                        if (!dispensingDevices.has(ip)) {
                            updateDeviceStatus(ip, '연결됨');
                        }
                    }
                } else {
                    // 비정상 응답 - 일시적 응답 없음으로 처리
                    if (!dispensingDevices.has(ip)) {
                        updateDeviceStatus(ip, '일시적 응답 없음');
                        allConnected = false;
                    }
                }
            } catch (error) {
                // 조제 중인 기기는 상태를 보존 (ESP32는 듀얼코어로 통신 가능)
                if (dispensingDevices.has(ip)) {
                    logMessage(`조제 중인 기기는 연결 상태 유지: ${ip} - 오류: ${error.message}`);
                } else {
                    // 404 오류는 기기 엔드포인트 문제일 수 있지만 실제 연결 상태와는 무관할 수 있음
                    // 따라서 404 오류는 상태를 변경하지 않고 로그만 남김
                    if (error.response && error.response.status === 404) {
                        // 404 오류는 무시하고 상태 유지 (실제로는 연결되어 있을 수 있음)
                        // 로그는 silent 모드에서만 출력하지 않음
                    } else {
                        // 404가 아닌 다른 오류는 "일시적 응답 없음"으로 변경
                        updateDeviceStatus(ip, '일시적 응답 없음');
                        logMessage(`연결 상태 확인 오류: ${ip} - ${error.message}`);
                        allConnected = false;
                    }
                }
            }
        }
        
        // 연결 상태에 따른 주기 조정
        if (hasConnectedDevices) {
            if (allConnected && connectionCheckIntervalMs === 5000) {
                // 모든 기기가 연결되었고 현재 빠른 모드라면 일반 모드로 전환
                setNormalConnectionCheck();
            } else if (!allConnected && connectionCheckIntervalMs === 15000) {
                // 연결되지 않은 기기가 있고 현재 일반 모드라면 빠른 모드로 전환
                setFastConnectionCheck();
            }
        }
        
        // 연결 상태 변경 후 약물 색상 갱신
        updateMedicineColors();
        
        // 연결 상태가 "연결됨"으로 변경된 경우 대기열 확인 및 처리
        // 조제가 진행 중이 아니고 대기열에 처방전이 있으면 처리 시도
        if (allConnected && autoDispensingQueue.length > 0 && !isAutoDispensingInProgress) {
            logMessage('연결 상태 확인: 모든 기기가 연결됨 - 대기열 처리 시도');
            processNextInQueue();
        }
        
    } catch (error) {
        logMessage(`연결 상태 확인 중 오류: ${error.message}`);
    } finally {
        isCheckingStatus = false;
    }
}

// 기기 상태 업데이트
function updateDeviceStatus(ip, status) {
    for (const [mac, deviceInfo] of Object.entries(connectedDevices)) {
        if (deviceInfo.ip === ip) {
            connectedDevices[mac].status = status;
            
            // 연결된 기기 테이블 업데이트
            const rows = elements.connectedTableBody.querySelectorAll('tr');
            for (const row of rows) {
                if (row.cells[2].textContent === ip) {
                    row.cells[3].textContent = status;
                    row.cells[4].textContent = moment().format('HH:mm:ss');
                    break;
                }
            }
            break;
        }
    }
    
    // 연결 상태 변경 시 약물 색상도 갱신
    updateMedicineColors();
}

// 처방전 파일 모니터링
let prescriptionWatcher = null;
let prescriptionPollInterval = null;
const pendingPrescriptionFiles = new Map();

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStableFile(filePath, options = {}) {
    const {
        stableChecks = 3,
        checkIntervalMs = 200,
        maxWaitMs = 10000
    } = options;
    let lastSize = -1;
    let stableCount = 0;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
        try {
            if (!fs.existsSync(filePath)) {
                await sleep(checkIntervalMs);
                continue;
            }

            const size = fs.statSync(filePath).size;
            if (size > 0 && size === lastSize) {
                stableCount++;
                if (stableCount >= stableChecks) {
                    return true;
                }
            } else {
                stableCount = 0;
                lastSize = size;
            }
        } catch (error) {
            stableCount = 0;
        }

        await sleep(checkIntervalMs);
    }

    try {
        return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
    } catch (error) {
        return false;
    }
}

function schedulePrescriptionFileProcessing(filePath) {
    const existingTimer = pendingPrescriptionFiles.get(filePath);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    const timerId = setTimeout(async () => {
        pendingPrescriptionFiles.delete(filePath);

        if (!fs.existsSync(filePath)) {
            return;
        }

        const isPdf = prescriptionParseMode === 'pdf_bag';
        if (isPdf) {
            const stable = await waitForStableFile(filePath);
            if (!stable) {
                logMessage(`⚠️ PDF 파일 쓰기 완료 대기 시간 초과: ${path.basename(filePath)}`);
                return;
            }
        }

        processNewPrescriptionFile(filePath);
    }, isPdfModeDelay());

    pendingPrescriptionFiles.set(filePath, timerId);
}

function isPdfModeDelay() {
    return prescriptionParseMode === 'pdf_bag' ? 400 : 100;
}

// 새 파일 처리 함수 (공통 로직)
function processNewPrescriptionFile(filePath) {
    try {
        // 약국 등록 및 승인 상태 확인
        if (pharmacyStatus === null || pharmacyStatus === 'pending' || pharmacyStatus === 'rejected') {
            return;
        }
        
        const fileExtension = getPrescriptionWatchExtension();
        if (!filePath.toLowerCase().endsWith(fileExtension)) {
            return;
        }
        
        if (parsedFiles.has(filePath)) {
            return; // 이미 처리된 파일
        }
        
        logMessage(`새 파일 감지: ${path.basename(filePath)}`);
        
        // 로그인 이후에만 파싱 카운터 증가
        if (isLoggedInSession) {
            newFileParseCount++;
            logMessage(`📊 새 파일 파싱 카운트: ${newFileParseCount} (로그인 이후)`);
        } else {
            logMessage(`ℹ️ 로그인 전 파일 파싱 - 카운트하지 않음: ${path.basename(filePath)}`);
        }
        
        const continueAfterParse = (receiptNumber) => {
            if (!receiptNumber) {
                return;
            }
            
            let datePart = '';
            if (prescriptionParseMode === 'pdf_bag') {
                const prescription = parsedPrescriptions[receiptNumber];
                if (prescription) {
                    datePart = prescription.patient.receipt_date.replace(/-/g, '');
                }
            } else if (prescriptionProgram === 'pm3000') {
                datePart = receiptNumber.substring(0, 8);
            } else {
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    const orderDtMatch = content.match(/<OrderDt>([^<]+)<\/OrderDt>/);
                    if (orderDtMatch) {
                        datePart = orderDtMatch[1];
                        logMessage(`유팜 XML 파일에서 날짜 추출: ${datePart} (${path.basename(filePath)})`);
                    } else {
                        logMessage(`유팜 XML 파일에서 OrderDt 태그를 찾을 수 없음: ${path.basename(filePath)}`);
                    }
                } catch (error) {
                    logMessage(`유팜 XML 파일 날짜 추출 실패: ${path.basename(filePath)} - ${error.message}`);
                }
            }
            
            if (!/^20\d{6}$/.test(datePart)) {
                return;
            }
            
            const formatted = `${datePart.substring(0,4)}-${datePart.substring(4,6)}-${datePart.substring(6,8)}`;
            elements.datePicker.value = formatted;
            filterPatientsByDate();
            
            if (autoDispensing) {
                const prescription = parsedPrescriptions[receiptNumber];
                if (prescription && prescription.patient.receipt_date === formatted) {
                    const fileExt = getPrescriptionWatchExtension();
                    
                    const hasRegisteredMedicine = prescription.medicines.some(med =>
                        isMedicineRegistered(med)
                    );
                    
                    if (!hasRegisteredMedicine) {
                        logMessage(`처방전 '${receiptNumber}${fileExt}'은(는) 등록된 시럽조제기에 매핑되는 약물이 없어 자동조제 대기열에 추가하지 않습니다.`);
                        return;
                    }
                    
                    const hasRegisteredDevice = prescription.medicines.some(med =>
                        findConnectedDeviceForMedicine(med, false) !== undefined
                    );
                    
                    if (!hasRegisteredDevice) {
                        logMessage(`처방전 '${receiptNumber}${fileExt}'은(는) 등록된 기기가 없습니다.`);
                        return;
                    }
                    
                    const hasConnectedOrBusyDevice = prescription.medicines.some(med =>
                        findConnectedDeviceForMedicine(med, true) !== undefined
                    );
                    
                    if (!hasConnectedOrBusyDevice) {
                        logMessage(`처방전 '${receiptNumber}${fileExt}'은(는) 등록된 기기는 있으나 현재 연결 대기 상태입니다. 대기열에 추가하고 즉시 처리 시도합니다.`);
                    }
                    
                    if (autoDispensingQueue.includes(receiptNumber)) {
                        logMessage(`처방전 '${receiptNumber}${fileExt}'이(가) 이미 대기열에 있습니다.`);
                        return;
                    }
                    
                    autoDispensingQueue.push(receiptNumber);
                    logMessage(`새로운 처방전 '${receiptNumber}${fileExt}'이(가) 감지되어 대기열에 추가되었습니다. (대기 중인 처방전: ${autoDispensingQueue.length}개)`);
                    
                    if (!isAutoDispensingInProgress) {
                        processNextInQueue();
                    }
                }
            }
        };
        
        if (prescriptionParseMode === 'pdf_bag') {
            parsePrescriptionFile(filePath).then(async (receiptNumber) => {
                if (!receiptNumber) {
                    const stable = await waitForStableFile(filePath, {
                        stableChecks: 2,
                        checkIntervalMs: 500,
                        maxWaitMs: 8000
                    });
                    if (stable && !parsedFiles.has(filePath)) {
                        const retryReceiptNumber = await parsePrescriptionFile(filePath);
                        continueAfterParse(retryReceiptNumber);
                        return;
                    }
                }
                continueAfterParse(receiptNumber);
            });
        } else {
            const receiptNumber = path.basename(filePath, fileExtension);
            parsePrescriptionFile(filePath);
            continueAfterParse(receiptNumber);
        }
    } catch (error) {
        logMessage(`파일 처리 중 오류: ${error.message}`);
    }
}

function startPrescriptionMonitor() {
    if (!prescriptionPath) return;
    
    // 기존 모니터링 중지
    if (prescriptionWatcher) {
        prescriptionWatcher.close();
        prescriptionWatcher = null;
    }
    if (prescriptionPollInterval) {
        clearInterval(prescriptionPollInterval);
        prescriptionPollInterval = null;
    }
    
    // fs.watch를 사용한 실시간 파일 감시
    try {
        prescriptionWatcher = fs.watch(prescriptionPath, { recursive: false }, (eventType, filename) => {
            if (!filename) return;
            
            // 약국 등록 및 승인 상태 확인
            if (pharmacyStatus === null || pharmacyStatus === 'pending' || pharmacyStatus === 'rejected') {
                return;
            }
            
            const fileExtension = getPrescriptionWatchExtension();
            if (!filename.toLowerCase().endsWith(fileExtension)) {
                return;
            }
            
            // 파일이 생성되었을 때만 처리
            if (eventType === 'rename' || eventType === 'change') {
                const filePath = path.join(prescriptionPath, filename);
                schedulePrescriptionFileProcessing(filePath);
            }
        });
        
        logMessage(`✅ 실시간 파일 감시 시작 (fs.watch) - ${prescriptionParseMode === 'pdf_bag' ? 'PDF' : getPrescriptionWatchExtension()} 파일`);
    } catch (error) {
        logMessage(`⚠️ fs.watch 실패, 폴링 모드로 전환: ${error.message}`);
        
        // fs.watch가 실패하면 폴링 방식으로 폴백
        prescriptionPollInterval = setInterval(() => {
            try {
                // 약국 등록 및 승인 상태 확인
                if (pharmacyStatus === null || pharmacyStatus === 'pending' || pharmacyStatus === 'rejected') {
                    return;
                }
                
                const fileExtension = getPrescriptionWatchExtension();
                const files = fs.readdirSync(prescriptionPath)
                    .filter(file => file.toLowerCase().endsWith(fileExtension))
                    .map(file => path.join(prescriptionPath, file));
                
                files.forEach(filePath => {
                    if (!parsedFiles.has(filePath)) {
                        schedulePrescriptionFileProcessing(filePath);
                    }
                });
            } catch (error) {
                logMessage(`파일 모니터링 중 오류: ${error.message}`);
            }
        }, 500); // 폴링 주기를 500ms로 단축
    }
}

// 네트워크 스캔 모달 표시
async function showNetworkScanModal() {
    const modal = new bootstrap.Modal(document.getElementById('networkScanModal'));
    modal.show();
    
    // 모달이 표시되면 초기 상태 설정
    updateScanStatus('대기중', 'info');
    
    // 네트워크 정보 다시 감지
    const detected = await detectAllNetworks();
    if (detected) {
        // 네트워크 콤보박스 업데이트
        updateNetworkCombo();
        
        // 현재 선택된 네트워크 프리픽스가 있으면 유지, 없으면 첫 번째로 설정
        const networkCombo = document.getElementById('networkCombo');
        if (networkCombo && networkPrefix) {
            networkCombo.value = networkPrefix;
        }
        
        logMessage(`네트워크 스캔 준비 완료: ${networkPrefix || '선택되지 않음'}`);
    } else {
        logMessage('네트워크 감지 실패. 수동으로 설정해주세요.');
        updateScanStatus('네트워크 감지 실패', 'error');
    }
    
    // 모달이 표시되면 즉시 스캔 시작
    setTimeout(() => {
        if (networkPrefix) {
            scanNetwork();
        }
    }, 500);
}

// 스캔 상태 업데이트
function updateScanStatus(status, type = 'info') {
    const statusElement = document.getElementById('scanStatus');
    if (!statusElement) return;
    
    let badgeClass = 'bg-secondary';
    let icon = 'fas fa-info-circle';
    
    switch (type) {
        case 'scanning':
            badgeClass = 'bg-primary';
            icon = 'fas fa-search';
            break;
        case 'success':
            badgeClass = 'bg-success';
            icon = 'fas fa-check-circle';
            break;
        case 'error':
            badgeClass = 'bg-danger';
            icon = 'fas fa-exclamation-circle';
            break;
        case 'warning':
            badgeClass = 'bg-warning';
            icon = 'fas fa-exclamation-triangle';
            break;
        default:
            badgeClass = 'bg-secondary';
            icon = 'fas fa-info-circle';
    }
    
    statusElement.className = `badge ${badgeClass}`;
    statusElement.innerHTML = `<i class="${icon} me-1"></i>${status}`;
}

function showAllPatients() {
    elements.patientTableBody.innerHTML = '';
    
    // 모든 처방전을 최신 순으로 정렬
    const sortedPrescriptions = Object.values(parsedPrescriptions)
        .sort((a, b) => {
            // receipt_time을 기준으로 내림차순 정렬 (최신이 위로)
            return b.patient.receipt_time.localeCompare(a.patient.receipt_time);
        });
    
    sortedPrescriptions.forEach(prescription => {
        const row = document.createElement('tr');
        
        // 기존 전송상태 확인
        const savedStatus = transmissionStatus[prescription.patient.receipt_number];
        let statusBadge = '<span class="badge bg-secondary">대기</span>';
        
        if (savedStatus) {
            const badgeClass = savedStatus === '완료' ? 'bg-success' : 'bg-danger';
            statusBadge = `<span class="badge ${badgeClass}">${savedStatus}</span>`;
        }
        
        row.innerHTML = `
            <td>${prescription.patient.name}</td>
            <td>${prescription.patient.receipt_time}</td>
            <td>${prescription.patient.receipt_number}</td>
            <td>${statusBadge}</td>
        `;
        row.dataset.receiptNumber = prescription.patient.receipt_number;
        elements.patientTableBody.appendChild(row);
    });
    
    logMessage(`전체 환자 목록 표시: ${sortedPrescriptions.length}명 (최신 순 정렬)`);
}

// 전송 상태 저장
async function saveTransmissionStatus() {
    try {
        const data = JSON.stringify(transmissionStatus);
        const filePath = await getConfigFilePath('transmission_status.json');
        fs.writeFileSync(filePath, data, 'utf8');
        console.log('[saveTransmissionStatus] 전송상태 저장됨:', Object.keys(transmissionStatus).length, '개');
    } catch (error) {
        console.error('[saveTransmissionStatus] 저장 오류:', error.message);
    }
}

// 전송 상태 로드
async function loadTransmissionStatus() {
    try {
        const filePath = await getConfigFilePath('transmission_status.json');
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            transmissionStatus = JSON.parse(data);
            
            // 기존 문자열 상태를 숫자로 변환 (호환성)
            Object.keys(transmissionStatus).forEach(key => {
                const status = transmissionStatus[key];
                if (typeof status === 'string') {
                    if (status === '성공' || status === '완료') {
                        transmissionStatus[key] = 0; // 기존 성공 상태를 0으로 초기화 (새로운 전송 횟수 계산을 위해)
                    } else if (status === '실패' || status === '대기' || status === '대기중') {
                        transmissionStatus[key] = 0;
                    }
                }
            });
            
            console.log('[loadTransmissionStatus] 전송상태 로드됨:', Object.keys(transmissionStatus).length, '개');
        } else {
            // 파일이 존재하지 않으면 빈 객체로 초기화
            transmissionStatus = {};
            console.log('[loadTransmissionStatus] 전송상태 파일이 없어 빈 객체로 초기화');
        }
    } catch (error) {
        console.error('[loadTransmissionStatus] 로드 오류:', error.message);
        transmissionStatus = {};
    }
}

// 약물별 전송 상태 저장
async function saveMedicineTransmissionStatus() {
    try {
        const data = JSON.stringify(medicineTransmissionStatus);
        const filePath = await getConfigFilePath('medicine_transmission_status.json');
        fs.writeFileSync(filePath, data, 'utf8');
        console.log('[saveMedicineTransmissionStatus] 약물별 전송상태 저장됨:', Object.keys(medicineTransmissionStatus).length, '개');
    } catch (error) {
        console.error('[saveMedicineTransmissionStatus] 저장 오류:', error.message);
    }
}

// 약물별 전송 상태 로드
async function loadMedicineTransmissionStatus() {
    try {
        const filePath = await getConfigFilePath('medicine_transmission_status.json');
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            medicineTransmissionStatus = JSON.parse(data);
            
            // 기존 문자열 상태를 숫자로 변환 (호환성)
            Object.keys(medicineTransmissionStatus).forEach(key => {
                const status = medicineTransmissionStatus[key];
                if (typeof status === 'string') {
                    if (status === '성공' || status === '완료') {
                        medicineTransmissionStatus[key] = 0; // 기존 성공 상태를 0으로 초기화 (새로운 전송 횟수 계산을 위해)
                    } else if (status === '실패' || status === '대기' || status === '대기중') {
                        medicineTransmissionStatus[key] = 0;
                    }
                    // '등록되지 않은 약물'은 그대로 유지
                }
            });
            
            console.log('[loadMedicineTransmissionStatus] 약물별 전송상태 로드됨:', Object.keys(medicineTransmissionStatus).length, '개');
        } else {
            // 파일이 존재하지 않으면 빈 객체로 초기화
            medicineTransmissionStatus = {};
            console.log('[loadMedicineTransmissionStatus] 약물별 전송상태 파일이 없어 빈 객체로 초기화');
        }
    } catch (error) {
        console.error('[loadMedicineTransmissionStatus] 로드 오류:', error.message);
        medicineTransmissionStatus = {};
    }
}

// 약물별 전송 상태 업데이트
async function updateMedicineTransmissionStatus(receiptNumber, medicineCode, status, forceUpdate = false) {
    console.log('[updateMedicineTransmissionStatus] 호출됨:', receiptNumber, medicineCode, status, 'forceUpdate:', forceUpdate);
    
    const key = `${receiptNumber}_${medicineCode}`;
    const currentStatus = medicineTransmissionStatus[key];
    
    // 상태 보호 로직: 이미 성공한 약물은 실패로 덮어쓰지 않음 (재전송 시 제외)
    if (isSuccessStatus(currentStatus) && status === 0 && !forceUpdate) {
        console.log(`[updateMedicineTransmissionStatus] 상태 보호: ${medicineCode}는 이미 성공 상태이므로 실패로 변경하지 않음`);
        logMessage(`약물 ${medicineCode} 상태 보호: 이미 성공 상태 유지`);
        return;
    }
    
    // 상태 업데이트
    medicineTransmissionStatus[key] = status;
    
    // 파일에 저장
    await saveMedicineTransmissionStatus();
    
    // 현재 표시된 약물 테이블에서 해당 약물의 상태 업데이트
    const rows = elements.medicineTableBody.querySelectorAll('tr:not(.empty-row)');
    let updated = false;
    
    rows.forEach(row => {
        if (row.dataset.pillCode === medicineCode) {
            const statusCell = row.cells[7]; // 8번째 컬럼 (0부터 시작하므로 7) - 전송상태
            const badgeClass = getStatusBadgeClass(status);
            const statusText = getStatusText(status);
            statusCell.innerHTML = `<span class="badge ${badgeClass}">${statusText}</span>`;
            updated = true;
            console.log('[updateMedicineTransmissionStatus] 약물 상태 업데이트 성공:', medicineCode, status, '배지클래스:', badgeClass);
            logMessage(`약물 ${medicineCode} 상태 업데이트: ${status}`);
        }
    });
    
    // 현재 환자 테이블에서도 전송상태 업데이트
    updatePatientTransmissionStatus(receiptNumber);
    
    // 행 색상 업데이트
    updateMedicineRowColors();
    
    if (!updated) {
        console.log('[updateMedicineTransmissionStatus] 현재 표시된 테이블에서 약물을 찾을 수 없음:', medicineCode);
    }
}

// 환자별 전송상태 업데이트
function updatePatientTransmissionStatus(receiptNumber) {
    const prescription = parsedPrescriptions[receiptNumber];
    if (!prescription) return;
    
    // 기존에 저장된 환자 전송상태 확인
    const existingStatus = transmissionStatus[receiptNumber];
    
    // 등록된 약물들만 필터링하여 상태 확인
    const registeredMedicineStatuses = prescription.medicines
        .filter(medicine => isMedicineRegistered(medicine))
        .map(medicine => {
            const key = getMedicineStatusKey(receiptNumber, medicine);
            return medicineTransmissionStatus[key] || 0;
        });
    
    console.log(`[updatePatientTransmissionStatus] 등록된 약물 상태들:`, registeredMedicineStatuses);
    console.log(`[updatePatientTransmissionStatus] 기존 환자 상태:`, existingStatus);
    
    // 전체 상태 결정 - 약물들의 최대 전송횟수를 반영
    let overallStatus = 0;
    
    if (registeredMedicineStatuses.length === 0) {
        // 등록된 약물이 없는 경우
        overallStatus = 0;
        logMessage(`환자 ${receiptNumber}: 등록된 약물이 없음`);
    } else {
        // 등록된 약물들의 최대 전송횟수를 환자 전체 상태로 설정
        const numericStatuses = registeredMedicineStatuses.filter(s => typeof s === 'number');
        if (numericStatuses.length > 0) {
            const maxCount = Math.max(...numericStatuses);
            overallStatus = maxCount;
            logMessage(`환자 ${receiptNumber}: 약물들의 최대 전송 횟수: ${maxCount}`);
        } else {
            // 숫자가 아닌 상태들만 있는 경우 (예: "등록되지 않은 약물")
            overallStatus = 0;
            logMessage(`환자 ${receiptNumber}: 숫자 상태가 없음, 0으로 설정`);
        }
    }
    
    // 환자 테이블에서 해당 환자의 전송상태 업데이트
    const patientRows = elements.patientTableBody.querySelectorAll('tr');
    patientRows.forEach(row => {
        if (row.dataset.receiptNumber === receiptNumber) {
            const statusCell = row.cells[3]; // 4번째 컬럼 (0부터 시작하므로 3)
            const badgeClass = getStatusBadgeClass(overallStatus);
            const statusText = getStatusText(overallStatus);
            statusCell.innerHTML = `<span class="badge ${badgeClass}">${statusText}</span>`;
            console.log('[updatePatientTransmissionStatus] 환자 전송상태 업데이트:', receiptNumber, overallStatus);
        }
    });
    
    // 전송상태 저장
    transmissionStatus[receiptNumber] = overallStatus;
    saveTransmissionStatus();
}



// 테이블에서 선택된 약물들 재전송
async function retrySelectedMedicinesFromTable() {
    let selectedPatient = document.querySelector('#patientTableBody tr.table-primary');
    if (!selectedPatient) {
        showMessage('warning', '환자를 선택해주세요.');
        return;
    }
    
    const receiptNumber = selectedPatient.dataset.receiptNumber;
    const prescription = parsedPrescriptions[receiptNumber];
    if (!prescription) {
        showMessage('error', '처방전 정보를 찾을 수 없습니다.');
        return;
    }
    
    // 선택된 약물들만 필터링
    const selectedMedicines = prescription.medicines.filter(medicine => {
        const checkbox = document.querySelector(`.medicine-checkbox[data-pill-code="${getMedicineMatchId(medicine)}"]`);
        return checkbox && checkbox.checked;
    });
    
    if (selectedMedicines.length === 0) {
        showMessage('warning', '재전송할 약물을 선택해주세요.');
        return;
    }
    
    // 재전송 실행
    await retrySelectedMedicines(selectedMedicines);
}

// 선택된 약물들 재전송
async function retrySelectedMedicines(selectedMedicines) {
    let selectedPatient = document.querySelector('#patientTableBody tr.table-primary');
    if (!selectedPatient) {
        showMessage('error', '환자 정보를 찾을 수 없습니다.');
        return;
    }
    
    const receiptNumber = selectedPatient.dataset.receiptNumber;
    
    logMessage(`선택된 약물 ${selectedMedicines.length}개를 병렬 재전송합니다.`);
    
    // 조제 시작 시 연결 상태 확인 일시 중단
    if (connectionCheckInterval) {
        clearInterval(connectionCheckInterval);
        connectionCheckInterval = null;
        logMessage('재전송 시작 - 연결 상태 확인 일시 중단');
    }
    
    // 조제 진행 중 플래그 설정 및 연결 상태 확인 지연 시작
    isDispensingInProgress = true;
    startConnectionCheckDelay(5); // 5초 동안 연결 상태 확인 지연
    
    // 선택된 약물들을 병렬로 재전송
    const retryPromises = selectedMedicines.map(async (medicine) => {
        const connectedDevice = findConnectedDeviceForMedicine(medicine, true);
        
        if (!connectedDevice) {
            logMessage(`${medicine.pill_name}은(는) 연결되지 않은 약물이므로 건너뜁니다.`);
            return {
                success: false,
                medicine: medicine,
                reason: '연결되지 않은 약물'
            };
        }
        
        logMessage(`병렬 재전송 시작: ${medicine.pill_name}, 총량: ${medicine.total}`);
        
        // 조제 중에도 ESP32는 듀얼코어로 통신 가능하므로 상태는 "연결됨" 유지
        
        try {
            const data = `TV${medicine.total} FF FF FF`;
            const response = await makeStableRequest(`http://${connectedDevice.ip}/dispense`, {
                amount: data
            }, {
                timeout: COMMUNICATION_CONFIG.TIMEOUTS.RETRY
            });
            
            if (response.status === 200) {
                logMessage(`${medicine.pill_name} 재전송 성공`);
                
                // 성공 시 약물 전송상태를 증가
                const key = getMedicineStatusKey(receiptNumber, medicine);
                const currentStatus = medicineTransmissionStatus[key] || 0;
                const newStatus = incrementTransmissionCount(currentStatus);
                await updateMedicineTransmissionStatus(receiptNumber, getMedicineMatchId(medicine), newStatus, true);
                
                return {
                    success: true,
                    medicine: medicine,
                    device: connectedDevice
                };
            } else {
                logMessage(`${medicine.pill_name} 재전송 실패: ${response.status}`);
                
                await updateMedicineTransmissionStatus(receiptNumber, getMedicineMatchId(medicine), 0); // 실패는 0으로 표시
                
                return {
                    success: false,
                    medicine: medicine,
                    device: connectedDevice,
                    reason: `HTTP 오류 (${response.status})`
                };
            }
        } catch (error) {
            logMessage(`${medicine.pill_name} 재전송 중 오류: ${error.message}`);
            
            await updateMedicineTransmissionStatus(receiptNumber, getMedicineMatchId(medicine), 0); // 실패는 0으로 표시
            
            return {
                success: false,
                medicine: medicine,
                device: connectedDevice,
                reason: error.message.includes('timeout') ? '통신 타임아웃 (10초 초과)' : 
                       error.message.includes('ECONNREFUSED') ? '연결 거부' :
                       error.message.includes('ENETUNREACH') ? '네트워크 연결 불가' : 
                       `통신 오류: ${error.message}`
            };
        }
    });
    
    // 모든 재전송 완료 대기
    const results = await Promise.all(retryPromises);
    
    // 결과 분석
    const successMedicines = results.filter(result => result.success).map(result => result.medicine);
    const failedMedicinesRetry = results.filter(result => !result.success).map(result => ({
        name: result.medicine.pill_name,
        code: prescriptionParseMode === 'pdf_bag' ? result.medicine.pill_name : result.medicine.pill_code,
        reason: result.reason
    }));
    
    const totalRetry = selectedMedicines.length;
    const successCount = successMedicines.length;
    const failedCount = failedMedicinesRetry.length;
    
    if (failedCount === 0) {
        showMessage('success', `모든 선택한 약물 재전송이 성공적으로 완료되었습니다.\n성공: ${successCount}개`);
    } else {
        let errorMessage = `재전송 결과:\n• 성공: ${successCount}개\n• 실패: ${failedCount}개\n\n`;
        
        if (failedMedicinesRetry.length > 0) {
            errorMessage += '▼ 재전송 실패 약물:\n';
            failedMedicinesRetry.forEach(medicine => {
                errorMessage += `• ${medicine.name} (${medicine.code})\n  → ${medicine.reason}\n`;
            });
        }
        
        showMessage('warning', errorMessage);
        logMessage(`재전송 결과: ${errorMessage}`);
    }
}

// 실패한 약물만 재전송 (기존 함수 - 호환성 유지)
async function retryFailedMedicines() {
    let selectedPatient = document.querySelector('#patientTableBody tr.table-primary');
    if (!selectedPatient) {
        showMessage('warning', '환자를 선택해주세요.');
        return;
    }
    
    const receiptNumber = selectedPatient.dataset.receiptNumber;
    const prescription = parsedPrescriptions[receiptNumber];
    if (!prescription) {
        showMessage('error', '처방전 정보를 찾을 수 없습니다.');
        return;
    }
    
    // 실패한 약물들만 필터링 (등록된 약물 중에서만) - 상태가 0인 약물들
    const failedMedicines = prescription.medicines.filter(medicine => {
        const key = getMedicineStatusKey(receiptNumber, medicine);
        return medicineTransmissionStatus[key] === 0 && isMedicineRegistered(medicine);
    });
    
    // 등록되지 않은 약물들도 확인
    const unregisteredMedicines = prescription.medicines.filter(medicine => {
        const key = getMedicineStatusKey(receiptNumber, medicine);
        return medicineTransmissionStatus[key] === 0 && !isMedicineRegistered(medicine);
    });
    
    if (failedMedicines.length === 0 && unregisteredMedicines.length === 0) {
        showMessage('info', '재전송할 실패한 약물이 없습니다.');
        return;
    }
    
    if (unregisteredMedicines.length > 0) {
        logMessage(`등록되지 않은 약물 ${unregisteredMedicines.length}개는 재전송에서 제외됩니다.`);
    }
    
    if (failedMedicines.length === 0) {
        showMessage('info', '재전송할 수 있는 실패한 약물이 없습니다. (등록되지 않은 약물은 재전송 불가)');
        return;
    }
    
    logMessage(`실패한 약물 ${failedMedicines.length}개를 병렬 재전송합니다.`);
    
    // 조제 시작 시 연결 상태 확인 일시 중단
    if (connectionCheckInterval) {
        clearInterval(connectionCheckInterval);
        connectionCheckInterval = null;
        logMessage('재전송 시작 - 연결 상태 확인 일시 중단');
    }
    
    // 조제 진행 중 플래그 설정 및 연결 상태 확인 지연 시작
    isDispensingInProgress = true;
    startConnectionCheckDelay(5); // 5초 동안 연결 상태 확인 지연
    
    // 연결된 실패한 약물들만 필터링
    const connectedFailedMedicines = failedMedicines.filter(medicine => {
        return findConnectedDeviceForMedicine(medicine, true) !== undefined;
    });
    
    const notConnectedMedicines = failedMedicines.filter(medicine => {
        return !findConnectedDeviceForMedicine(medicine, true);
    });
    
    // 연결되지 않은 약물들을 실패 상태로 표시
    notConnectedMedicines.forEach(medicine => {
        logMessage(`${medicine.pill_name}은(는) 연결되지 않은 약물이므로 건너뜁니다.`);
    });
    
    if (connectedFailedMedicines.length === 0) {
        showMessage('warning', '재전송할 연결된 약물이 없습니다.');
        return;
    }
    
    // 모든 실패한 약물을 병렬로 재전송
    const retryPromises = connectedFailedMedicines.map(async (medicine) => {
        const connectedDevice = findConnectedDeviceForMedicine(medicine, true);
        
        logMessage(`병렬 재전송 시작: ${medicine.pill_name}, 총량: ${medicine.total}`);
        
        // 조제 중에도 ESP32는 듀얼코어로 통신 가능하므로 상태는 "연결됨" 유지
        
        try {
            const data = `TV${medicine.total} FF FF FF`;
            const response = await makeStableRequest(`http://${connectedDevice.ip}/dispense`, {
                amount: data
            }, {
                timeout: COMMUNICATION_CONFIG.TIMEOUTS.RETRY
            });
            
            if (response.status === 200) {
                logMessage(`${medicine.pill_name} 재전송 성공`);
                
                // 성공 시 약물 전송상태를 증가 (재전송이므로 forceUpdate = true)
                const key = getMedicineStatusKey(receiptNumber, medicine);
                const currentStatus = medicineTransmissionStatus[key] || 0;
                const newStatus = incrementTransmissionCount(currentStatus);
                await updateMedicineTransmissionStatus(receiptNumber, getMedicineMatchId(medicine), newStatus, true);
                
                return {
                    success: true,
                    medicine: medicine,
                    device: connectedDevice
                };
            } else {
                logMessage(`${medicine.pill_name} 재전송 실패: ${response.status}`);
                
                await updateMedicineTransmissionStatus(receiptNumber, getMedicineMatchId(medicine), 0); // 실패는 0으로 표시
                
                return {
                    success: false,
                    medicine: medicine,
                    device: connectedDevice,
                    reason: `HTTP 오류 (${response.status})`
                };
            }
        } catch (error) {
            logMessage(`${medicine.pill_name} 재전송 중 오류: ${error.message}`);
            
            await updateMedicineTransmissionStatus(receiptNumber, getMedicineMatchId(medicine), 0); // 실패는 0으로 표시
            
            return {
                success: false,
                medicine: medicine,
                device: connectedDevice,
                reason: error.message.includes('timeout') ? '통신 타임아웃 (10초 초과)' : 
                       error.message.includes('ECONNREFUSED') ? '연결 거부' :
                       error.message.includes('ENETUNREACH') ? '네트워크 연결 불가' : 
                       `통신 오류: ${error.message}`
            };
        }
    });
    
    // 모든 재전송 완료 대기
    const results = await Promise.all(retryPromises);
    
    // 결과 분석
    const successMedicines = results.filter(result => result.success).map(result => result.medicine);
    const failedMedicinesRetry = results.filter(result => !result.success).map(result => ({
        name: result.medicine.pill_name,
        code: prescriptionParseMode === 'pdf_bag' ? result.medicine.pill_name : result.medicine.pill_code,
        reason: result.reason
    }));
    
    const totalRetry = connectedFailedMedicines.length;
    const successCount = successMedicines.length;
    const failedCount = failedMedicinesRetry.length + notConnectedMedicines.length;
    
    if (failedCount === 0) {
        // showMessage('success', `모든 실패한 약물 재전송이 성공적으로 완료되었습니다.\n성공: ${successCount}개`);
    } else {
        let errorMessage = `재전송 결과:\n• 성공: ${successCount}개\n• 실패: ${failedCount}개\n\n`;
        
        if (failedMedicinesRetry.length > 0) {
            errorMessage += '▼ 재전송 실패 약물:\n';
            failedMedicinesRetry.forEach(medicine => {
                errorMessage += `• ${medicine.name} (${medicine.code})\n  → ${medicine.reason}\n`;
            });
        }
        
        if (notConnectedMedicines.length > 0) {
            errorMessage += '\n▼ 연결되지 않은 약물:\n';
            notConnectedMedicines.forEach(medicine => {
                errorMessage += `• ${medicine.name} (${medicine.code})\n  → 시럽조제기 연결 필요\n`;
            });
        }
        
        logMessage(`재전송 결과: ${errorMessage}`);
    }
}

// 약물별 전송 상태 초기화
function resetMedicineTransmissionStatus() {
    let selectedPatient = document.querySelector('#patientTableBody tr.table-primary');
    if (!selectedPatient) {
        showMessage('warning', '환자를 선택해주세요.');
        return;
    }
    
    const receiptNumber = selectedPatient.dataset.receiptNumber;
    const prescription = parsedPrescriptions[receiptNumber];
    if (!prescription) {
        showMessage('error', '처방전 정보를 찾을 수 없습니다.');
        return;
    }
    
    // 해당 환자의 모든 약물 전송상태를 0으로 초기화
    prescription.medicines.forEach(medicine => {
        const key = getMedicineStatusKey(receiptNumber, medicine);
        
        // 등록되지 않은 약물은 "등록되지 않은 약물" 상태로 유지
        if (!isMedicineRegistered(medicine)) {
            medicineTransmissionStatus[key] = '등록되지 않은 약물';
        } else {
            medicineTransmissionStatus[key] = 0;
        }
    });
    
    // 파일에 저장
    saveMedicineTransmissionStatus();
    
    // 현재 표시된 약물 테이블 업데이트
    loadPatientMedicines(receiptNumber);
    
    showMessage('info', '약물별 전송상태가 초기화되었습니다.');
}

// 약물별 전송 상태에 따른 행 색상 업데이트
function updateMedicineRowColors() {
    const rows = elements.medicineTableBody.querySelectorAll('tr:not(.empty-row)');
    rows.forEach(row => {
        const pillCode = row.dataset.pillCode;
        if (!pillCode) return;
        
        // 기존 상태 클래스 제거
        row.classList.remove('medicine-success', 'medicine-failed', 'medicine-dispensing');
        
        // 현재 선택된 환자 확인
        const selectedPatient = document.querySelector('#patientTableBody tr.table-primary');
        if (!selectedPatient) return;
        
        const receiptNumber = selectedPatient.dataset.receiptNumber;
        const key = `${receiptNumber}_${pillCode}`;
        const status = medicineTransmissionStatus[key];
        
        // 상태에 따른 클래스 추가
        if (isSuccessStatus(status)) {
            row.classList.add('medicine-success');
        } else if (status === 0) {
            row.classList.add('medicine-failed');
        } else if (status === '조제중') {
            row.classList.add('medicine-dispensing');
        }
    });
}

// 연결 상태 확인 지연 시작
function startConnectionCheckDelay(delaySeconds = 5) {
    logMessage(`조제 후 연결 상태 확인을 ${delaySeconds}초 동안 지연시킵니다.`);
    
    // 기존 지연 타이머가 있으면 취소
    if (connectionCheckDelayTimer) {
        clearTimeout(connectionCheckDelayTimer);
    }
    
    // 조제 진행 중 플래그 설정
    isDispensingInProgress = true;
    
    // 지연 시간 후에 연결 상태 확인 재시작
    connectionCheckDelayTimer = setTimeout(() => {
        isDispensingInProgress = false;
        connectionCheckDelayTimer = null;
        
        // 연결 상태 확인 재시작
        if (!connectionCheckInterval) {
            connectionCheckInterval = setInterval(checkConnectionStatus, 15000);
            logMessage('조제 후 지연 시간 완료 - 연결 상태 확인 재시작');
        }
    }, delaySeconds * 1000);
}

// 연결 상태 확인 지연 취소
function cancelConnectionCheckDelay() {
    if (connectionCheckDelayTimer) {
        clearTimeout(connectionCheckDelayTimer);
        connectionCheckDelayTimer = null;
        isDispensingInProgress = false;
        logMessage('연결 상태 확인 지연이 취소되었습니다.');
    }
}

// PDF 연동 시 약물명 정규화 및 시럽조제기 매칭
function normalizeMedicineName(name) {
    if (!name) return '';
    return String(name)
        .replace(/\s+/g, '')
        .replace(/[()（）\[\]{}<>].*$/, '')
        .replace(/[()（）\[\]{}<>]/g, '')
        .toLowerCase();
}

function medicineNamesMatch(prescriptionName, deviceName) {
    const a = normalizeMedicineName(prescriptionName);
    const b = normalizeMedicineName(deviceName);
    if (!a || !b) return false;
    return a === b || a.includes(b) || b.includes(a);
}

function getMedicineMatchId(medicine) {
    if (typeof medicine === 'string') {
        return prescriptionParseMode === 'pdf_bag'
            ? normalizeMedicineName(medicine)
            : medicine;
    }
    if (prescriptionParseMode === 'pdf_bag') {
        return normalizeMedicineName(medicine.pill_name);
    }
    return medicine.pill_code || '';
}

function getMedicineStatusKey(receiptNumber, medicine) {
    return `${receiptNumber}_${getMedicineMatchId(medicine)}`;
}

function savedDeviceMatchesMedicine(device, medicine) {
    if (prescriptionParseMode === 'pdf_bag') {
        return medicineNamesMatch(medicine.pill_name, device.nickname);
    }
    return device.pill_code === medicine.pill_code;
}

function connectedDeviceMatchesMedicine(device, medicine) {
    return savedDeviceMatchesMedicine(device, medicine);
}

function deviceMatchesMedicineId(device, matchId) {
    if (prescriptionParseMode === 'pdf_bag') {
        return medicineNamesMatch(matchId, device.nickname);
    }
    return device.pill_code === matchId;
}

function findConnectedDeviceForMedicine(medicine, requireConnected = false) {
    return Object.values(connectedDevices).find(device => {
        if (!connectedDeviceMatchesMedicine(device, medicine)) return false;
        if (requireConnected && device.status !== '연결됨') return false;
        return true;
    });
}

// 저장된 시럽조제기 목록에서 약물 확인 (PDF: 약물명, EMR: 약품코드)
function isMedicineRegistered(medicine) {
    if (typeof medicine === 'string') {
        if (prescriptionParseMode === 'pdf_bag') {
            return Object.values(savedConnections).some(device =>
                medicineNamesMatch(medicine, device.nickname)
            );
        }
        return Object.values(savedConnections).some(device => device.pill_code === medicine);
    }
    return Object.values(savedConnections).some(device =>
        savedDeviceMatchesMedicine(device, medicine)
    );
}

// 수동조제 행 동적 관리
let manualRowId = 0;
let manualRows = [];

function showManualPage() {
    elements.mainPage.style.display = 'none';
    elements.networkPage.style.display = 'none';
    document.getElementById('manualPage').style.display = 'block';
    renderManualRows();
}

function renderManualRows() {
    const container = document.getElementById('manualRowsContainer');
    container.innerHTML = '';
    manualRows.forEach(row => {
        container.appendChild(row.elem);
    });
}

// 수동조제 줄 상태 저장/복원
const MANUAL_ROWS_STORAGE_KEY = 'manualRowsState';

function saveManualRowsState() {
    const state = manualRows.map(row => ({
        mac: row.getSelectedMac ? row.getSelectedMac() : null,
        total: row.getTotal ? row.getTotal() : ''
    }));
    localStorage.setItem(MANUAL_ROWS_STORAGE_KEY, JSON.stringify(state));
}

function loadManualRowsState() {
    try {
        const state = JSON.parse(localStorage.getItem(MANUAL_ROWS_STORAGE_KEY));
        if (!Array.isArray(state) || state.length === 0) return false;
        manualRows = state.map(item => createManualRow(item.mac, item.total));
        renderManualRows();
        return true;
    } catch {
        return false;
    }
}

// createManualRow(mac, total)로 수정
function createManualRow(initMac = null, initTotal = '') {
    const rowId = ++manualRowId;
    let selectedMac = initMac;

    // 행 컨테이너
    const rowDiv = document.createElement('div');
    rowDiv.className = 'manual-row d-flex align-items-center gap-2 mb-2';
    rowDiv.dataset.rowId = rowId;

    // 시럽조제기 드롭다운 ...
    const dropdownDiv = document.createElement('div');
    dropdownDiv.className = 'dropdown flex-grow-1';
    const dropdownBtn = document.createElement('button');
    dropdownBtn.className = 'btn btn-outline-primary btn-sm dropdown-toggle w-100';
    dropdownBtn.type = 'button';
    dropdownBtn.dataset.bsToggle = 'dropdown';
    dropdownBtn.ariaExpanded = 'false';
    dropdownBtn.textContent = '시럽조제기를 선택하세요';
    const dropdownList = document.createElement('ul');
    dropdownList.className = 'dropdown-menu w-100';

    // 복원 시 드롭다운 텍스트 세팅
    if (initMac && savedConnections[initMac]) {
        const info = savedConnections[initMac];
        dropdownBtn.textContent = info.nickname;
    }

    dropdownBtn.addEventListener('click', () => {
        dropdownList.innerHTML = '';
        Object.entries(savedConnections).forEach(([mac, info]) => {
            const li = document.createElement('li');
            li.className = 'dropdown-item';
            li.textContent = info.nickname;
            li.onclick = () => {
                selectedMac = mac;
                dropdownBtn.textContent = info.nickname;
                updateStatus();
                saveManualRowsState();
            };
            dropdownList.appendChild(li);
        });
    });
    dropdownDiv.appendChild(dropdownBtn);
    dropdownDiv.appendChild(dropdownList);

    // 연결상태 ...
    const statusSpan = document.createElement('span');
    statusSpan.className = 'status-disconnected badge';
    statusSpan.style.minWidth = '60px';
    statusSpan.textContent = '-';
    function updateStatus() {
        if (!selectedMac) {
            statusSpan.textContent = '-';
            statusSpan.className = 'status-disconnected';
            return;
        }
        let status = '연결끊김';
        let statusClass = 'status-disconnected';
        if (connectedDevices[selectedMac] && connectedDevices[selectedMac].status === '연결됨') {
            status = '연결됨';
            statusClass = 'status-connected';
        }
        statusSpan.textContent = status;
        statusSpan.className = statusClass;
    }

    // 총량 입력 ...
    const totalInput = document.createElement('input');
    totalInput.type = 'number';
    totalInput.className = 'form-control form-control-sm';
    totalInput.placeholder = '총량';
    totalInput.style.maxWidth = '80px';
    totalInput.value = initTotal;
    totalInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            sendBtn.click();
        }
    });
    totalInput.addEventListener('input', saveManualRowsState);

    // 전송 버튼 ...
    const sendBtn = document.createElement('button');
    sendBtn.className = 'btn btn-success btn-sm';
    sendBtn.innerHTML = '<i class="fas fa-paper-plane me-1"></i>전송';
    sendBtn.style.minWidth = '60px';
    sendBtn.onclick = async function() {
        await sendManualDispense(false); // 일반 전송
    };

    // 긴급 전송 버튼 ...
    const urgentBtn = document.createElement('button');
    urgentBtn.className = 'btn btn-danger btn-sm';
    urgentBtn.innerHTML = '<i class="fas fa-exclamation-triangle me-1"></i>긴급';
    urgentBtn.style.minWidth = '60px';
    urgentBtn.onclick = async function() {
        await sendManualDispense(true); // 긴급 전송
    };

    // 전송 함수 (일반/긴급 통합)
    async function sendManualDispense(isUrgent) {
        if (!selectedMac) {
            await showMessage('warning', '시럽조제기를 선택하세요.');
            return;
        }
        const info = savedConnections[selectedMac];
        const total = totalInput.value;
        if (!total || isNaN(total) || Number(total) <= 0) {
            await showMessage('warning', '총량을 올바르게 입력하세요.');
            return;
        }
        
        // 시럽 최대량 검증
        if (Number(total) > maxSyrupAmount) {
            const message = `총량 ${total}mL가 설정된 최대량 ${maxSyrupAmount}mL를 초과합니다.\n\n해결 방법:\n• 설정에서 시럽 최대량을 ${total}mL 이상으로 조정\n• 더 작은 용량으로 분할하여 전송\n• 현재 설정: ${maxSyrupAmount}mL`;
            await showMessage('warning', message);
            return;
        }
        
        if (!connectedDevices[selectedMac] || connectedDevices[selectedMac].status !== '연결됨') {
            await showMessage('warning', '선택한 시럽조제기가 연결되어 있지 않습니다.');
            return;
        }
        
        const device = connectedDevices[selectedMac];
        const statusId = addManualStatus({ 
            syrupName: info.nickname, 
            total: total + (isUrgent ? ' (긴급)' : '')
        });
        
        try {
            // 조제 중에도 ESP32는 듀얼코어로 통신 가능하므로 상태는 "연결됨" 유지
            dispensingDevices.add(device.ip); // 조제 중인 기기 목록에 추가 (연결 상태 확인 시 참고용)
            
            const data = {
                patient_name: isUrgent ? '긴급조제' : '수동조제',
                total_volume: total,
                urgent: isUrgent
            };
            
            // 재시도 로직 (최대 3회)
            const maxRetries = 3;
            let lastError = null;
            let response = null;
            
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    if (attempt > 1) {
                        const delay = Math.min(1000 * Math.pow(2, attempt - 2), 4000); // 지수 백오프: 1초, 2초, 4초
                        logMessage(`수동조제 재시도 ${attempt}/${maxRetries} (${delay/1000}초 대기 후...)`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                    
                    response = await axios.post(`http://${device.ip}/dispense`, data, {
                        timeout: 30000,
                        headers: { 'Content-Type': 'application/json' }
                    });
                    
                    // 성공 시 루프 종료
                    break;
                    
                } catch (error) {
                    lastError = error;
                    const isLastAttempt = attempt === maxRetries;
                    
                    // 404 에러는 기기 엔드포인트 문제일 수 있음
                    if (error.response && error.response.status === 404) {
                        logMessage(`수동조제 전송 실패 (시도 ${attempt}/${maxRetries}): 기기 엔드포인트를 찾을 수 없음 (404)`);
                    } else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
                        logMessage(`수동조제 전송 실패 (시도 ${attempt}/${maxRetries}): 타임아웃`);
                    } else if (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH') {
                        logMessage(`수동조제 전송 실패 (시도 ${attempt}/${maxRetries}): 기기 연결 불가`);
                    } else {
                        logMessage(`수동조제 전송 실패 (시도 ${attempt}/${maxRetries}): ${error.message}`);
                    }
                    
                    // 마지막 시도가 아니면 계속, 마지막 시도면 에러 던지기
                    if (isLastAttempt) {
                        throw lastError;
                    }
                }
            }
            
            // 성공 응답 처리
            logMessage(`수동조제 응답: ${JSON.stringify(response.data)}`);
            
            // 모든 200 응답(BUSY 포함)을 성공으로 처리
            if (response.data === "BUSY") {
                logMessage(`수동조제: 조제 중 - 대기열에 추가됨 (성공으로 처리)`);
            } else {
                logMessage(`수동조제: 데이터 전송 성공`);
            }
            updateManualStatus(statusId, '완료');
            totalInput.value = '';
            totalInput.placeholder = '총량';
            
            // 조제 완료 - 기기 상태는 "연결됨" 유지 (변경 불필요)
            dispensingDevices.delete(device.ip); // 조제 중인 기기 목록에서 제거
            updateStatus();
            saveManualRowsState();
            
        } catch (error) {
            updateManualStatus(statusId, '실패');
            
            // 최종 실패 메시지
            if (error.response && error.response.status === 404) {
                logMessage(`수동조제 최종 실패: 기기 엔드포인트를 찾을 수 없음 (404) - 기기 상태를 확인하세요`);
            } else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
                logMessage(`수동조제 최종 실패: 타임아웃 - 기기 응답이 없습니다`);
            } else if (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH') {
                logMessage(`수동조제 최종 실패: 기기 연결 불가 - 네트워크 연결을 확인하세요`);
            } else {
                logMessage(`수동조제 최종 실패: ${error.message}`);
            }
            
            // 실패 시에도 기기 상태는 "연결됨" 유지 (ESP32는 듀얼코어로 통신 가능)
            if (connectedDevices[selectedMac]) {
                dispensingDevices.delete(device.ip); // 조제 중인 기기 목록에서 제거
                updateStatus();
            }
        }
    }

    // 행 삭제 버튼 ...
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-outline-danger btn-sm';
    delBtn.innerHTML = '<i class="fas fa-times"></i>';
    delBtn.style.minWidth = '40px';
    delBtn.onclick = function() {
        manualRows = manualRows.filter(r => r.id !== rowId);
        renderManualRows();
        saveManualRowsState();
    };

    // 버튼들을 담을 컨테이너 생성
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'd-flex gap-1';
    buttonContainer.appendChild(sendBtn);
    buttonContainer.appendChild(urgentBtn);
    buttonContainer.appendChild(delBtn);

    rowDiv.appendChild(dropdownDiv);
    rowDiv.appendChild(statusSpan);
    rowDiv.appendChild(totalInput);
    rowDiv.appendChild(buttonContainer);

    // getter for 저장
    function getSelectedMac() { return selectedMac; }
    function getTotal() { return totalInput.value; }

    return { id: rowId, elem: rowDiv, updateStatus, getSelectedMac, getTotal };
}

// 줄 추가 버튼 이벤트
if (document.getElementById('addManualRowBtn')) {
    document.getElementById('addManualRowBtn').onclick = function() {
        manualRows.push(createManualRow());
        renderManualRows();
        saveManualRowsState();
    };
}

// 수동조제 페이지 진입 시 저장된 줄 복원, 없으면 1줄 생성
if (document.getElementById('manualPage')) {
    if (!loadManualRowsState()) {
        manualRows = [createManualRow()];
        renderManualRows();
    }
}

// 수동조제 행 상태 전체 갱신
function updateAllManualRowStatus() {
    manualRows.forEach(row => {
        if (row && typeof row.updateStatus === 'function') {
            row.updateStatus();
        }
    });
}

// 기존 updateConnectedTable 함수 마지막에 추가
const _origUpdateConnectedTable = updateConnectedTable;
updateConnectedTable = function() {
    _origUpdateConnectedTable.apply(this, arguments);
    updateAllManualRowStatus();
};

// manualPage 진입시에는 복원하지 않음 (중복 방지)
if (document.getElementById('manualPage')) {
    // 복원은 loadConnections에서만!
    if (!fs.existsSync('connections.json')) {
        manualRows = [createManualRow()];
        renderManualRows();
    }
}

// 설정 파일 경로 관리
let userDataPath = '';

// 사용자 데이터 디렉토리 경로 가져오기
async function getUserDataPath() {
    if (!userDataPath) {
        userDataPath = await ipcRenderer.invoke('get-user-data-path');
    }
    return userDataPath;
}

// 설정 파일 경로 생성
async function getConfigFilePath(filename) {
    const userData = await getUserDataPath();
    return path.join(userData, filename);
}

// 통신 설정 및 재시도 로직
const COMMUNICATION_CONFIG = {
    // 타임아웃 설정
    TIMEOUTS: {
        CONNECTION_CHECK: 5000,    // 연결 확인: 5초
        RETRY: 15000,              // 재전송: 15초 (10초에서 증가)
        DISPENSE: 30000,           // 일반 전송: 30초
        SCAN: 5000                 // 스캔: 5초
    },
    // 재시도 설정
    RETRY: {
        MAX_ATTEMPTS: 3,           // 최대 재시도 횟수
        DELAY_BETWEEN_RETRIES: 1000, // 재시도 간 대기 시간 (1초)
        BACKOFF_MULTIPLIER: 1.5    // 지수 백오프 배수
    }
};

// 적응적 재시도 함수
async function retryWithBackoff(operation, maxAttempts = COMMUNICATION_CONFIG.RETRY.MAX_ATTEMPTS) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            
            // 마지막 시도가 아니고 재시도 가능한 오류인 경우에만 재시도
            if (attempt < maxAttempts && isRetryableError(error)) {
                const delay = COMMUNICATION_CONFIG.RETRY.DELAY_BETWEEN_RETRIES * 
                             Math.pow(COMMUNICATION_CONFIG.RETRY.BACKOFF_MULTIPLIER, attempt - 1);
                
                logMessage(`통신 실패 (${attempt}/${maxAttempts}), ${delay}ms 후 재시도: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                break;
            }
        }
    }
    
    throw lastError;
}

// 재시도 가능한 오류인지 판단
function isRetryableError(error) {
    const retryableErrors = [
        'ECONNABORTED',
        'ECONNREFUSED', 
        'ENETUNREACH',
        'ETIMEDOUT',
        'timeout'
    ];
    
    return retryableErrors.some(retryableError => 
        error.code === retryableError || 
        error.message.includes(retryableError)
    );
}

// 안정적인 HTTP 요청 함수
async function makeStableRequest(url, data, options = {}) {
    const defaultOptions = {
        timeout: COMMUNICATION_CONFIG.TIMEOUTS.DISPENSE,
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    };
    
    const requestOptions = { ...defaultOptions, ...options };
    
    return retryWithBackoff(async () => {
        const response = await axios.post(url, data, requestOptions);
        return response;
    });
}

// 통신 상태 모니터링
const communicationStats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    averageResponseTime: 0,
    responseTimes: [],
    lastNetworkQuality: 'unknown'
};

// 네트워크 품질 측정
function measureNetworkQuality(responseTime) {
    communicationStats.responseTimes.push(responseTime);
    
    // 최근 10개 응답 시간만 유지
    if (communicationStats.responseTimes.length > 10) {
        communicationStats.responseTimes.shift();
    }
    
    // 평균 응답 시간 계산
    const avgTime = communicationStats.responseTimes.reduce((sum, time) => sum + time, 0) / communicationStats.responseTimes.length;
    communicationStats.averageResponseTime = avgTime;
    
    // 네트워크 품질 판단
    if (avgTime < 1000) {
        communicationStats.lastNetworkQuality = 'excellent';
    } else if (avgTime < 3000) {
        communicationStats.lastNetworkQuality = 'good';
    } else if (avgTime < 5000) {
        communicationStats.lastNetworkQuality = 'fair';
    } else {
        communicationStats.lastNetworkQuality = 'poor';
    }
    
    return communicationStats.lastNetworkQuality;
}

// 통신 성공률 계산
function getCommunicationSuccessRate() {
    if (communicationStats.totalRequests === 0) return 100;
    return (communicationStats.successfulRequests / communicationStats.totalRequests) * 100;
}

// 통신 통계 로그 출력
function logCommunicationStats() {
    const successRate = getCommunicationSuccessRate();
    logMessage(`통신 통계: 총 ${communicationStats.totalRequests}회, 성공 ${communicationStats.successfulRequests}회, 실패 ${communicationStats.failedRequests}회, 성공률 ${successRate.toFixed(1)}%, 평균 응답시간 ${communicationStats.averageResponseTime.toFixed(0)}ms, 네트워크 품질: ${communicationStats.lastNetworkQuality}`);
}

// 거리 기반 적응적 타임아웃 설정
function getAdaptiveTimeout(baseTimeout, networkQuality = 'unknown') {
    const qualityMultipliers = {
        'excellent': 1.0,    // 거리 가까움, 신호 강함
        'good': 1.2,         // 거리 보통, 신호 양호
        'fair': 1.5,         // 거리 멀음, 신호 약함
        'poor': 2.0,         // 거리 매우 멀음, 신호 불안정
        'unknown': 1.5       // 기본값
    };
    
    const multiplier = qualityMultipliers[networkQuality] || 1.5;
    return Math.round(baseTimeout * multiplier);
}

// 네트워크 환경 진단
async function diagnoseNetworkEnvironment() {
    logMessage('네트워크 환경 진단 시작...');
    
    const testResults = [];
    const testIPs = Object.values(connectedDevices).map(device => device.ip);
    
    for (const ip of testIPs) {
        const startTime = Date.now();
        try {
            const response = await axios.get(`http://${ip}`, { 
                timeout: 10000,
                headers: { 'User-Agent': 'SyrupDispenser/1.0' }
            });
            const responseTime = Date.now() - startTime;
            testResults.push({ ip, responseTime, success: true });
            
            // 네트워크 품질 측정
            const quality = measureNetworkQuality(responseTime);
            logMessage(`기기 ${ip} 응답시간: ${responseTime}ms, 품질: ${quality}`);
            
        } catch (error) {
            const responseTime = Date.now() - startTime;
            testResults.push({ ip, responseTime, success: false, error: error.message });
            logMessage(`기기 ${ip} 연결 실패: ${error.message}`);
        }
    }
    
    // 전체 네트워크 환경 평가
    const successfulTests = testResults.filter(r => r.success);
    if (successfulTests.length > 0) {
        const avgResponseTime = successfulTests.reduce((sum, r) => sum + r.responseTime, 0) / successfulTests.length;
        const quality = measureNetworkQuality(avgResponseTime);
        
        logMessage(`네트워크 환경 진단 완료: 평균 응답시간 ${avgResponseTime.toFixed(0)}ms, 전체 품질: ${quality}`);
        
        // 타임아웃 설정 조정 제안
        const suggestedTimeouts = {
            connection_check: getAdaptiveTimeout(COMMUNICATION_CONFIG.TIMEOUTS.CONNECTION_CHECK, quality),
            retry: getAdaptiveTimeout(COMMUNICATION_CONFIG.TIMEOUTS.RETRY, quality),
            dispense: getAdaptiveTimeout(COMMUNICATION_CONFIG.TIMEOUTS.DISPENSE, quality)
        };
        
        logMessage(`권장 타임아웃 설정: 연결확인 ${suggestedTimeouts.connection_check}ms, 재전송 ${suggestedTimeouts.retry}ms, 전송 ${suggestedTimeouts.dispense}ms`);
        
        return { quality, avgResponseTime, suggestedTimeouts };
    } else {
        logMessage('네트워크 환경 진단 실패: 모든 기기 연결 실패');
        return { quality: 'poor', avgResponseTime: 0, suggestedTimeouts: null };
    }
}

// ── ESP32 펌웨어 (기본: ESP32-CODE/OTA, 로드셀: ESP32-CODE-LOADCELL/OTA) ─────
// 기본: /version 에 model 없음 또는 loadcell·hospital 아님 → ESP32-CODE
// 로드셀: /version 의 model === "loadcell" → ESP32-CODE-LOADCELL
const ESP_PC_BASIC_VERSION_URL =
    'https://raw.githubusercontent.com/pharmcoder-kr/ESP32-CODE/main/OTA/version.txt';
const ESP_PC_BASIC_FIRMWARE_URL =
    'https://raw.githubusercontent.com/pharmcoder-kr/ESP32-CODE/main/OTA/firmware.bin';
const ESP_PC_LOADCELL_VERSION_URL =
    'https://raw.githubusercontent.com/pharmcoder-kr/ESP32-CODE-LOADCELL/main/OTA/version.txt';
const ESP_PC_LOADCELL_FIRMWARE_URL =
    'https://raw.githubusercontent.com/pharmcoder-kr/ESP32-CODE-LOADCELL/main/OTA/firmware.bin';

let espFirmwareModalInstance = null;
let espLatestBasicCached = '';
let espLatestLoadcellCached = '';

/** @type {{ mac: string, ip: string, nickname: string, version: string|null, model: string|null, error: string|null, selected: boolean }[]} */
let espFirmwareRows = [];

function compareSemverPc(a, b) {
    const pa = String(a)
        .trim()
        .split(/[.\s]+/)
        .map((x) => parseInt(x, 10) || 0);
    const pb = String(b)
        .trim()
        .split(/[.\s]+/)
        .map((x) => parseInt(x, 10) || 0);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
        const da = pa[i] || 0;
        const db = pb[i] || 0;
        if (da > db) return 1;
        if (da < db) return -1;
    }
    return 0;
}

function parseEspVersionTxtFirstLine(text) {
    return String(text)
        .trim()
        .split(/\r?\n/)[0]
        .trim();
}

/** @returns {'basic'|'loadcell'|'hospital'} */
function espDeviceKindFromModel(modelRaw) {
    const s = modelRaw == null ? '' : String(modelRaw).trim().toLowerCase();
    if (s === 'hospital') return 'hospital';
    if (s === 'loadcell') return 'loadcell';
    return 'basic';
}

function espLatestForKind(kind) {
    if (kind === 'loadcell') return espLatestLoadcellCached;
    if (kind === 'basic') return espLatestBasicCached;
    return '';
}

function espFirmwareUrlForKind(kind) {
    if (kind === 'loadcell') return ESP_PC_LOADCELL_FIRMWARE_URL;
    return ESP_PC_BASIC_FIRMWARE_URL;
}

function buildEspFirmwareRowsFromConnections() {
    espFirmwareRows = Object.entries(connectedDevices)
        .filter(([, d]) => d.status === '연결됨')
        .map(([mac, d]) => ({
            mac,
            ip: d.ip,
            nickname: d.nickname || (savedConnections[mac] && savedConnections[mac].nickname) || mac,
            version: null,
            model: null,
            error: null,
            selected: true
        }));
}

function deviceNeedsOtaPc(row, latest) {
    if (!row.version || !latest) return false;
    return compareSemverPc(latest, row.version) > 0;
}

function deviceIsUpToDatePc(row, latest) {
    if (!row.version || !latest) return false;
    return compareSemverPc(row.version, latest) >= 0;
}

function renderFirmwareDeviceList() {
    const c = document.getElementById('firmwareDeviceListContainer');
    if (!c) return;
    c.innerHTML = '';

    if (espFirmwareRows.length === 0) {
        const p = document.createElement('p');
        p.className = 'text-muted small mb-0';
        p.textContent = '연결된 시럽조제기가 없습니다. 설정에서 기기를 연결하세요.';
        c.appendChild(p);
        return;
    }

    for (const row of espFirmwareRows) {
        const kind = espDeviceKindFromModel(row.model);
        if (kind === 'hospital') {
            row.selected = false;
        }

        const latest = espLatestForKind(kind);
        const latestOk = !!(latest && kind !== 'hospital');

        const card = document.createElement('div');
        card.className = 'firmware-device-card';

        const left = document.createElement('div');
        left.className = 'd-flex align-items-start gap-2 flex-grow-1 min-w-0';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'form-check-input mt-1';
        cb.checked = !!row.selected;
        cb.disabled = kind === 'hospital' || !!(row.error && !row.version);
        cb.addEventListener('change', () => {
            row.selected = cb.checked;
        });

        const textWrap = document.createElement('div');
        textWrap.className = 'flex-grow-1 min-w-0';
        const nameEl = document.createElement('div');
        nameEl.className = 'fw-semibold text-truncate';
        nameEl.textContent = row.nickname;
        const ipEl = document.createElement('div');
        ipEl.className = 'small text-secondary';
        ipEl.textContent = row.ip;
        const kindEl = document.createElement('div');
        kindEl.className = 'small text-muted';
        if (kind === 'loadcell') {
            kindEl.textContent = '모델: 로드셀 (loadcell)';
        } else if (kind === 'hospital') {
            kindEl.textContent = '모델: 병원용 (hospital)';
        } else {
            kindEl.textContent = '모델: 기본';
        }
        textWrap.appendChild(nameEl);
        textWrap.appendChild(ipEl);
        textWrap.appendChild(kindEl);

        left.appendChild(cb);
        left.appendChild(textWrap);

        const right = document.createElement('div');
        right.className = 'firmware-device-meta text-end flex-shrink-0';

        const verLine = document.createElement('div');
        verLine.className = 'small mb-1';
        if (row.error && !row.version) {
            verLine.textContent = '현재 버전: 확인 실패';
        } else if (row.version) {
            verLine.textContent = `현재 버전: ${row.version}`;
        } else {
            verLine.textContent = '현재 버전: —';
        }

        const badge = document.createElement('span');
        badge.className = 'badge rounded-pill';
        if (kind === 'hospital') {
            badge.classList.add('bg-secondary');
            badge.textContent = '병원용';
        } else if (row.error && !row.version) {
            badge.classList.add('bg-danger');
            badge.textContent = '오류';
        } else if (kind === 'loadcell' && !espLatestLoadcellCached) {
            badge.classList.add('bg-light', 'text-dark');
            badge.textContent = '원격 없음';
        } else if (kind === 'basic' && !espLatestBasicCached) {
            badge.classList.add('bg-light', 'text-dark');
            badge.textContent = '원격 없음';
        } else if (!latestOk) {
            badge.classList.add('bg-light', 'text-dark');
            badge.textContent = '—';
        } else if (deviceIsUpToDatePc(row, latest)) {
            badge.classList.add('firmware-badge-latest');
            badge.textContent = '최신 버전';
        } else if (deviceNeedsOtaPc(row, latest)) {
            badge.classList.add('bg-warning', 'text-dark');
            badge.textContent = '업데이트 필요';
        } else {
            badge.classList.add('bg-light', 'text-dark');
            badge.textContent = '—';
        }

        right.appendChild(verLine);
        right.appendChild(badge);

        card.appendChild(left);
        card.appendChild(right);
        c.appendChild(card);
    }
}

async function fetchEspVersionTxt(url) {
    const res = await axios.get(url, {
        timeout: 20000,
        responseType: 'text',
        transformResponse: [(d) => d]
    });
    const v = parseEspVersionTxtFirstLine(res.data);
    if (!v) throw new Error('version.txt 내용 없음');
    return v;
}

/** @returns {{ basicOk: boolean, loadcellOk: boolean, errors: string[] }} */
async function refreshEspFirmwareLatestBoth() {
    const basicInp = document.getElementById('espLatestBasicDisplay');
    const lcInp = document.getElementById('espLatestLoadcellDisplay');
    const prevBasic = espLatestBasicCached;
    const prevLoadcell = espLatestLoadcellCached;
    espLatestBasicCached = '';
    espLatestLoadcellCached = '';
    const errors = [];

    const [bRes, lRes] = await Promise.allSettled([
        fetchEspVersionTxt(ESP_PC_BASIC_VERSION_URL),
        fetchEspVersionTxt(ESP_PC_LOADCELL_VERSION_URL)
    ]);

    let basicOk = false;
    let loadcellOk = false;

    if (bRes.status === 'fulfilled') {
        espLatestBasicCached = bRes.value;
        basicOk = true;
        if (basicInp) basicInp.value = espLatestBasicCached;
    } else {
        const msg =
            bRes.reason && bRes.reason.response
                ? `기본 HTTP ${bRes.reason.response.status}`
                : bRes.reason
                  ? String(bRes.reason.message || bRes.reason)
                  : '실패';
        errors.push(`기본(ESP32-CODE/OTA): ${msg}`);
        espLatestBasicCached = prevBasic;
        if (basicInp) basicInp.value = prevBasic || '—';
    }

    if (lRes.status === 'fulfilled') {
        espLatestLoadcellCached = lRes.value;
        loadcellOk = true;
        if (lcInp) lcInp.value = espLatestLoadcellCached;
    } else {
        const msg =
            lRes.reason && lRes.reason.response
                ? `로드셀 HTTP ${lRes.reason.response.status}`
                : lRes.reason
                  ? String(lRes.reason.message || lRes.reason)
                  : '실패';
        errors.push(`로드셀(LOADCELL/OTA): ${msg}`);
        espLatestLoadcellCached = prevLoadcell;
        if (lcInp) lcInp.value = prevLoadcell || '—';
    }

    return { basicOk, loadcellOk, errors };
}

async function refreshEspDeviceVersionsOnly() {
    for (const row of espFirmwareRows) {
        try {
            const r = await axios.get(`http://${row.ip}/version`, { timeout: 10000 });
            row.version =
                r.data && r.data.version != null ? String(r.data.version).trim() : '';
            row.model =
                r.data && r.data.model != null ? String(r.data.model).trim() : '';
            row.error = null;
        } catch (e) {
            row.error = e.message || String(e);
            row.version = null;
            row.model = null;
        }
    }
}

/** OTA 직후 재부팅 구간에서 /version 실패를 줄이기 위해 재시도 */
async function refreshEspDeviceVersionsWithRetry(maxAttempts = 8, delayMs = 1500) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await refreshEspDeviceVersionsOnly();
        const anyMissing = espFirmwareRows.some((r) => r.error && !r.version);
        if (!anyMissing) {
            if (attempt > 0) {
                logMessage(`펌웨어: 기기 버전 확인 성공 (${attempt + 1}회차)`);
            }
            return;
        }
        if (attempt < maxAttempts - 1) {
            logMessage(
                `펌웨어: 기기 응답 대기 중… (${attempt + 1}/${maxAttempts}) 재부팅 후 곧 복구됩니다.`
            );
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
}

/**
 * @param {{ suppressGithubErrorDialog?: boolean, postOtaDeviceRetry?: boolean }} [options]
 *   suppressGithubErrorDialog — OTA 직후 등 GitHub가 막혀도 모달 경고를 띄우지 않음(로그만)
 *   postOtaDeviceRetry — 기기 /version 재시도(재부팅 직후 실패 완화)
 */
async function refreshEspFirmwareModalData(options = {}) {
    const suppressGithubDialog = options.suppressGithubErrorDialog === true;
    const postOtaRetry = options.postOtaDeviceRetry === true;

    logMessage('펌웨어: GitHub OTA(기본·로드셀) 및 기기 /version 조회…');
    const { basicOk, loadcellOk, errors } = await refreshEspFirmwareLatestBoth();
    try {
        if (postOtaRetry) {
            await refreshEspDeviceVersionsWithRetry(8, 1500);
        } else {
            await refreshEspDeviceVersionsOnly();
        }
    } catch (_) {
        /* ignore */
    }
    renderFirmwareDeviceList();

    if (!basicOk && !loadcellOk) {
        logMessage(`펌웨어: GitHub 전부 실패 — ${errors.join(' / ')}`);
        if (!suppressGithubDialog) {
            await showMessage(
                'warning',
                `최신 펌웨어(version.txt)를 가져오지 못했습니다.\n${errors.join('\n')}\n\n연결은 확인되며, GitHub·네트워크를 점검하세요.`
            );
        } else {
            logMessage(
                '펌웨어: GitHub 조회 실패(알림 생략). 모달「새로고침」으로 재시도하거나, 방화벽·DNS에서 raw.githubusercontent.com 접근을 확인하세요.'
            );
        }
    } else if (!basicOk || !loadcellOk) {
        logMessage(`펌웨어: 일부만 성공 — ${errors.join(' / ')}`);
        if (!suppressGithubDialog) {
            await showMessage(
                'warning',
                `한쪽 저장소만 조회되었습니다.\n${errors.join('\n')}\n\n해당 모델만 OTA 비교가 가능합니다.`
            );
        } else {
            logMessage('펌웨어: GitHub 일부 실패(알림 생략). 이전에 받아 둔 버전으로 비교합니다.');
        }
    } else {
        logMessage('펌웨어: 조회 완료 (기본·로드셀)');
    }
}

function openFirmwareUpdateModal() {
    const el = document.getElementById('firmwareUpdateModal');
    if (!el) return;
    buildEspFirmwareRowsFromConnections();
    renderFirmwareDeviceList();
    if (!espFirmwareModalInstance) {
        espFirmwareModalInstance = new bootstrap.Modal(el);
    }
    espFirmwareModalInstance.show();
    refreshEspFirmwareModalData();
}

function clampEspOtaPercent(n) {
    if (typeof n !== 'number' || Number.isNaN(n)) return 0;
    return Math.max(0, Math.min(100, n));
}

function showEspOtaProgressPanel(visible) {
    const panel = document.getElementById('espOtaProgressPanel');
    const list = document.getElementById('firmwareDeviceListContainer');
    if (panel) {
        panel.classList.toggle('d-none', !visible);
    }
    if (list) {
        list.classList.toggle('opacity-50', visible);
        list.style.pointerEvents = visible ? 'none' : '';
    }
}

function espOtaRowDomId(ip) {
    return `esp-ota-row-${String(ip).replace(/\./g, '-')}`;
}

function buildEspOtaParallelProgressRows(targets) {
    const wrap = document.getElementById('espOtaParallelRows');
    const summary = document.getElementById('espOtaParallelSummary');
    if (summary) {
        summary.textContent =
            targets.length > 0
                ? `${targets.length}대 동시 진행 — 각 기기 진행률은 아래와 같습니다.`
                : '—';
    }
    if (!wrap) return;
    wrap.replaceChildren();
    for (const row of targets) {
        const root = document.createElement('div');
        root.className = 'esp-ota-parallel-row mb-3';
        root.id = espOtaRowDomId(row.ip);
        root.dataset.ip = row.ip;

        const head = document.createElement('div');
        head.className = 'd-flex justify-content-between align-items-baseline gap-2 mb-1';

        const nameEl = document.createElement('span');
        nameEl.className = 'fw-semibold small text-truncate';
        nameEl.textContent = row.nickname || row.ip;

        const ipEl = document.createElement('span');
        ipEl.className = 'text-muted small flex-shrink-0';
        ipEl.textContent = row.ip;

        head.appendChild(nameEl);
        head.appendChild(ipEl);

        const track = document.createElement('div');
        track.className = 'progress esp-ota-progress-track';
        track.style.height = '1.05rem';

        const bar = document.createElement('div');
        bar.className =
            'progress-bar progress-bar-striped progress-bar-animated esp-ota-row-bar';
        bar.setAttribute('role', 'progressbar');
        bar.style.width = '0%';
        bar.setAttribute('aria-valuenow', '0');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.textContent = '0%';

        track.appendChild(bar);

        const det = document.createElement('div');
        det.className = 'esp-ota-row-detail small text-muted mt-1';
        det.textContent = '시작 대기…';

        root.appendChild(head);
        root.appendChild(track);
        root.appendChild(det);
        wrap.appendChild(root);
    }
}

/**
 * @param {string} ip
 * @param {number} percent
 * @param {string|null|undefined} detail
 * @param {'pending'|'running'|'ok'|'fail'} phase
 */
function updateEspOtaRowProgress(ip, percent, detail, phase) {
    const root = document.getElementById(espOtaRowDomId(ip));
    if (!root) return;
    const bar = root.querySelector('.esp-ota-row-bar');
    const det = root.querySelector('.esp-ota-row-detail');
    let p = clampEspOtaPercent(percent);
    if (phase === 'ok') p = 100;
    if (bar) {
        bar.style.width = `${p}%`;
        bar.textContent = `${Math.round(p)}%`;
        bar.setAttribute('aria-valuenow', String(Math.round(p)));
        bar.classList.remove('bg-success', 'bg-danger');
        if (phase === 'ok' || phase === 'fail') {
            bar.classList.remove('progress-bar-striped', 'progress-bar-animated');
        } else {
            bar.classList.add('progress-bar-striped', 'progress-bar-animated');
        }
        if (phase === 'ok') {
            bar.classList.add('bg-success');
        } else if (phase === 'fail') {
            bar.classList.add('bg-danger');
            bar.style.width = '100%';
            bar.textContent = '실패';
            bar.setAttribute('aria-valuenow', '100');
        }
    }
    if (det && detail != null) det.textContent = detail;
}

function setEspOtaAckVisible(visible) {
    const ack = document.getElementById('espOtaProgressAckBtn');
    if (!ack) return;
    ack.classList.toggle('d-none', !visible);
    ack.disabled = !visible;
    document.querySelectorAll('.esp-ota-row-bar').forEach((bar) => {
        if (visible) bar.classList.remove('progress-bar-animated');
        else bar.classList.add('progress-bar-animated');
    });
}

function setEspFirmwareOtaUiLocked(locked) {
    const ids = [
        'espFirmwareProceedBtn',
        'espFirmwareModalFooterClose',
        'espFirmwareModalHeaderClose',
        'espFirmwareModalRefreshBtn'
    ];
    for (const id of ids) {
        const el = document.getElementById(id);
        if (el) el.disabled = !!locked;
    }
}

function waitEspOtaProgressAck() {
    return new Promise((resolve) => {
        const btn = document.getElementById('espOtaProgressAckBtn');
        if (!btn) {
            resolve();
            return;
        }
        const onClick = () => {
            btn.removeEventListener('click', onClick);
            resolve();
        };
        btn.addEventListener('click', onClick);
    });
}

function espOtaDetailFromStatus(data, st) {
    if (data && data.message) return String(data.message);
    if (st === 'downloading') return '펌웨어 수신 중…';
    if (st === 'installing' || st === 'writing') return '플래시 기록 중…';
    if (st === 'rebooting') return '재부팅 중…';
    if (st === 'idle') return '대기';
    if (st === 'reconnecting') return '기기와 통신 재시도 중…';
    if (st) return `상태: ${st}`;
    return '상태 확인 중…';
}

/**
 * @param {string} ip
 * @param {{ maxMs?: number, onProgress?: (p: { partial: number, status: string|null, detail: string, raw: any }) => void }} [options]
 */
async function pollEspOtaStatusPc(ip, options = {}) {
    const maxMs = options.maxMs ?? 600000;
    const onProgress = options.onProgress;
    const t0 = Date.now();
    // ESP32 펌웨어(로드셀/기본)는 성공 시 "installing" 후 재부팅하고, 재부팅 뒤에는 "idle"로만 돌아옴.
    // "completed"를 보내지 않으면 아래 플래그 없이 폴링이 끝까지 실패 → 배치 OTA가 1대만 하고 중단됨.
    let sawOtaInProgress = false;

    while (Date.now() - t0 < maxMs) {
        await new Promise((r) => setTimeout(r, 1200));
        try {
            const { data } = await axios.get(`http://${ip}/ota/status`, { timeout: 8000 });
            const st = data && data.status;
            let pctFromDevice = null;
            if (data && typeof data.percent === 'number') {
                pctFromDevice = clampEspOtaPercent(data.percent);
            } else if (data && typeof data.progress === 'number') {
                pctFromDevice = clampEspOtaPercent(data.progress);
            }

            if (st === 'downloading' || st === 'installing') {
                sawOtaInProgress = true;
            } else if (pctFromDevice != null && pctFromDevice > 0) {
                sawOtaInProgress = true;
            }

            const elapsed = Date.now() - t0;
            let partial = pctFromDevice;
            if (partial == null) {
                partial = Math.min(94, 10 + (elapsed / maxMs) * 84);
            }

            const detail = espOtaDetailFromStatus(data, st);
            if (onProgress) {
                onProgress({ partial, status: st, detail, raw: data });
            }

            if (st === 'completed') return { ok: true };
            // 플래시 기록 완료 직후 재부팅 직전(또는 일부 빌드)
            if (st === 'installing') return { ok: true };
            if (st === 'failed') {
                return { ok: false, message: (data && data.message) || 'failed' };
            }
            // 다운로드/설치를 한 번이라도 본 뒤 재부팅되면 status가 idle로 리셋됨 → 성공으로 간주
            if (sawOtaInProgress && st === 'idle') {
                return { ok: true };
            }
        } catch (_) {
            const elapsed = Date.now() - t0;
            const partial = Math.min(94, 10 + (elapsed / maxMs) * 84);
            if (onProgress) {
                onProgress({
                    partial,
                    status: 'reconnecting',
                    detail: '기기 응답 대기 중… (재부팅·네트워크 지연 시 시간이 걸릴 수 있습니다)',
                    raw: null
                });
            }
        }
    }
    return { ok: false, message: '상태 확인 시간 초과' };
}

/**
 * 한 대 OTA (병렬 배치용). UI는 ip 기준 행만 갱신.
 * @returns {Promise<{ ok: boolean, nickname: string, message?: string }>}
 */
async function runSingleEspParallelOta(row, latest, fwUrl) {
    const ip = row.ip;
    const nick = row.nickname || ip;
    try {
        updateEspOtaRowProgress(ip, 2, '업데이트 시작 요청 전송 중…', 'running');
        logMessage(`펌웨어 OTA 시작: ${nick} (${ip}) → v${latest}`);

        await axios.post(
            `http://${ip}/ota/start`,
            { firmware_url: fwUrl, version: latest },
            { timeout: 15000, headers: { 'Content-Type': 'application/json' } }
        );

        updateEspOtaRowProgress(ip, 8, '기기에서 펌웨어를 받는 중…', 'running');

        const poll = await pollEspOtaStatusPc(ip, {
            maxMs: 600000,
            onProgress: ({ partial, detail }) => {
                updateEspOtaRowProgress(ip, partial, detail, 'running');
            }
        });

        if (!poll.ok) {
            updateEspOtaRowProgress(
                ip,
                100,
                `${poll.message || '결과 불확실'}. 새로고침 후 버전을 확인해 주세요.`,
                'fail'
            );
            logMessage(`펌웨어 OTA 실패(확인 필요): ${nick} — ${poll.message}`);
            return { ok: false, nickname: nick, message: poll.message };
        }

        updateEspOtaRowProgress(ip, 100, 'OTA 완료', 'ok');
        logMessage(`펌웨어 OTA 완료: ${nick}`);
        return { ok: true, nickname: nick };
    } catch (e) {
        const detail = e.response ? `HTTP ${e.response.status}` : e.message;
        updateEspOtaRowProgress(ip, 100, `오류: ${detail}`, 'fail');
        logMessage(`펌웨어 OTA 오류: ${nick} — ${detail}`);
        return { ok: false, nickname: nick, message: detail };
    }
}

async function proceedEspFirmwareBatchUpdate() {
    if (!espLatestBasicCached && !espLatestLoadcellCached) {
        await showMessage('warning', '최신 펌웨어를 먼저 불러오세요.「새로고침」을 눌러 주세요.');
        return;
    }

    const targets = espFirmwareRows.filter((row) => {
        if (!row.selected) return false;
        const kind = espDeviceKindFromModel(row.model);
        if (kind === 'hospital') return false;
        const latest = espLatestForKind(kind);
        if (!latest || !row.version) return false;
        return deviceNeedsOtaPc(row, latest);
    });

    if (targets.length === 0) {
        await showMessage(
            'info',
            'OTA로 내릴 기기가 없습니다. (이미 최신이거나, 병원용·오류·원격버전 없음은 제외됩니다.)'
        );
        return;
    }

    const summary = targets
        .map((row) => {
            const k = espDeviceKindFromModel(row.model);
            const lv = espLatestForKind(k);
            return `• ${row.nickname}: ${k === 'loadcell' ? '로드셀' : '기본'} → v${lv}`;
        })
        .join('\n');

    if (
        !confirm(
            `선택한 ${targets.length}대에 동시에 OTA를 진행합니다.\n\n${summary}\n\n전원을 끄지 마세요. 계속할까요?`
        )
    ) {
        return;
    }

    const btn = document.getElementById('espFirmwareProceedBtn');
    const n = targets.length;

    setEspFirmwareOtaUiLocked(true);
    if (btn) btn.disabled = true;
    showEspOtaProgressPanel(true);
    setEspOtaAckVisible(false);
    buildEspOtaParallelProgressRows(targets);

    try {
        const jobs = targets.map((row) => {
            const kind = espDeviceKindFromModel(row.model);
            const latest = espLatestForKind(kind);
            const fwUrl = espFirmwareUrlForKind(kind);
            return runSingleEspParallelOta(row, latest, fwUrl);
        });

        const results = await Promise.all(jobs);
        const failed = results.filter((r) => !r.ok);
        const batchFailed = failed.length > 0;

        const summaryEl = document.getElementById('espOtaParallelSummary');
        if (summaryEl) {
            if (!batchFailed) {
                summaryEl.textContent = `전체 완료: 성공 ${n}/${n}. 확인을 누르면 목록을 갱신합니다.`;
            } else {
                const names = failed.map((f) => f.nickname).join(', ');
                summaryEl.textContent = `전체 완료: 성공 ${n - failed.length}/${n}, 실패 ${failed.length}대 (${names}). 확인을 누르면 목록을 갱신합니다.`;
            }
        }

        setEspOtaAckVisible(true);
        await waitEspOtaProgressAck();
        await refreshEspFirmwareModalData({
            suppressGithubErrorDialog: true,
            postOtaDeviceRetry: true
        });
    } finally {
        showEspOtaProgressPanel(false);
        setEspOtaAckVisible(false);
        const wrap = document.getElementById('espOtaParallelRows');
        if (wrap) wrap.replaceChildren();
        setEspFirmwareOtaUiLocked(false);
        if (btn) btn.disabled = false;
    }
}

// ============================================
// 자동 업데이트 관련 함수
// ============================================

let updateModal = null;
let updateInfo = null;

// 앱 버전 정보 표시
async function displayAppVersion() {
    try {
        const version = await ipcRenderer.invoke('get-app-version');
        const versionElement = document.getElementById('appVersion');
        if (versionElement) {
            versionElement.textContent = `v${version}`;
        }
    } catch (error) {
        console.error('버전 정보 가져오기 오류:', error);
    }
}

// 수동으로 업데이트 확인
async function checkForUpdatesManually() {
    try {
        logMessage('업데이트 확인 중...');
        const result = await ipcRenderer.invoke('check-for-updates');
        
        if (result.success) {
            logMessage('업데이트 확인 완료');
        } else {
            logMessage(`업데이트 확인 실패: ${result.error}`);
            alert(`업데이트 확인 실패: ${result.error}`);
        }
    } catch (error) {
        console.error('업데이트 확인 오류:', error);
        logMessage(`업데이트 확인 오류: ${error.message}`);
    }
}

// 업데이트 다운로드
async function downloadUpdate() {
    try {
        const downloadBtn = document.getElementById('updateDownloadBtn');
        const laterBtn = document.getElementById('updateLaterBtn');
        const progressDiv = document.getElementById('updateProgress');
        
        // 버튼 비활성화
        downloadBtn.disabled = true;
        laterBtn.disabled = true;
        
        // 진행 상태 표시
        progressDiv.style.display = 'block';
        
        logMessage('업데이트 다운로드 시작...');
        
        const result = await ipcRenderer.invoke('download-update');
        
        if (!result.success) {
            throw new Error(result.error);
        }
    } catch (error) {
        console.error('업데이트 다운로드 오류:', error);
        logMessage(`업데이트 다운로드 오류: ${error.message}`);
        alert(`업데이트 다운로드 오류: ${error.message}`);
        
        // 버튼 다시 활성화
        const downloadBtn = document.getElementById('updateDownloadBtn');
        const laterBtn = document.getElementById('updateLaterBtn');
        downloadBtn.disabled = false;
        laterBtn.disabled = false;
    }
}

// 업데이트 설치
function installUpdate() {
    ipcRenderer.invoke('install-update');
}

// 메인 프로세스로부터 업데이트 이벤트 수신
ipcRenderer.on('update-available', (event, info) => {
    console.log('업데이트 사용 가능:', info);
    updateInfo = info;
    
    // 모달 표시
    showUpdateModal(info);
    
    logMessage(`새로운 버전 ${info.version} 사용 가능`);
});

ipcRenderer.on('update-not-available', (event, info) => {
    console.log('최신 버전입니다.');
});

ipcRenderer.on('update-error', (event, error) => {
    console.error('업데이트 오류:', error);
    logMessage(`업데이트 오류: ${error}`);
});

ipcRenderer.on('update-download-progress', (event, progress) => {
    console.log(`다운로드 진행: ${progress.percent.toFixed(1)}%`);
    
    const progressBar = document.getElementById('updateProgressBar');
    const progressText = document.getElementById('updateProgressText');
    
    if (progressBar && progressText) {
        const percent = Math.round(progress.percent);
        progressBar.style.width = `${percent}%`;
        progressBar.textContent = `${percent}%`;
        
        const transferred = (progress.transferred / 1024 / 1024).toFixed(1);
        const total = (progress.total / 1024 / 1024).toFixed(1);
        progressText.textContent = `다운로드 중... ${transferred}MB / ${total}MB`;
    }
});

ipcRenderer.on('update-downloaded', (event, info) => {
    console.log('업데이트 다운로드 완료');
    logMessage(`업데이트 다운로드 완료: v${info.version}`);
    
    // UI 업데이트
    const downloadBtn = document.getElementById('updateDownloadBtn');
    const installBtn = document.getElementById('updateInstallBtn');
    const laterBtn = document.getElementById('updateLaterBtn');
    const progressText = document.getElementById('updateProgressText');
    
    if (downloadBtn) downloadBtn.style.display = 'none';
    if (installBtn) installBtn.style.display = 'inline-block';
    if (laterBtn) laterBtn.textContent = '나중에 설치';
    if (progressText) progressText.textContent = '다운로드 완료! 지금 설치하거나 앱 종료 시 자동으로 설치됩니다.';
});

// 업데이트 모달 표시
function showUpdateModal(info) {
    const currentVersion = document.getElementById('currentVersion');
    const newVersion = document.getElementById('newVersion');
    const releaseNotes = document.getElementById('updateReleaseNotes');
    
    // 현재 버전 표시
    ipcRenderer.invoke('get-app-version').then(version => {
        if (currentVersion) currentVersion.textContent = version;
    });
    
    // 새 버전 표시
    if (newVersion) newVersion.textContent = info.version;
    
    // 릴리스 노트 표시
    if (releaseNotes) {
        if (info.releaseNotes) {
            // HTML 형식의 릴리스 노트
            if (typeof info.releaseNotes === 'string') {
                releaseNotes.innerHTML = info.releaseNotes;
            } else if (Array.isArray(info.releaseNotes)) {
                // 배열 형식의 릴리스 노트
                releaseNotes.innerHTML = info.releaseNotes.map(note => {
                    if (typeof note === 'string') {
                        return `<p>${note}</p>`;
                    } else if (note.note) {
                        return `<p>${note.note}</p>`;
                    }
                    return '';
                }).join('');
            }
        } else {
            releaseNotes.innerHTML = '<p class="text-muted">업데이트 정보가 없습니다.</p>';
        }
    }
    
    // 모달 초기화 및 표시
    const modalElement = document.getElementById('updateModal');
    if (modalElement) {
        updateModal = new bootstrap.Modal(modalElement);
        updateModal.show();
    }
}

// 초기화 시 버전 정보 표시
document.addEventListener('DOMContentLoaded', () => {
    displayAppVersion();
});