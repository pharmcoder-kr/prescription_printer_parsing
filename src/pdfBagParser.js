const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

const PDFJS_VERSION = 'v1.10.100';

function configurePdfJsForElectron() {
    try {
        const pdfJsModule = require(path.join(
            __dirname, '..', 'node_modules', 'pdf-parse', 'lib', 'pdf.js', PDFJS_VERSION, 'build', 'pdf.js'
        ));

        if (pdfJsModule.PDFJS) {
            pdfJsModule.PDFJS.disableWorker = true;
        }

        const globalScope = typeof window !== 'undefined'
            ? window
            : (typeof global !== 'undefined' ? global : {});

        if (!globalScope.PDFJS) {
            globalScope.PDFJS = pdfJsModule.PDFJS || {};
        }
        globalScope.PDFJS.disableWorker = true;
    } catch (error) {
        console.warn('PDFJS worker 설정 중 오류:', error.message);
    }
}

configurePdfJsForElectron();

const DRUG_KEYWORD_PATTERN = '(?:시럽|현탁액|건조시럽|시럽용분말|액)';

const DEFAULT_PARSER = {
    profile: 'auto',
    patientNamePatterns: [
        '([가-힣A-Za-z]{2,20})\\s*\\(\\s*만\\s*\\d+\\s*세\\s*/\\s*[남여]\\s*\\)',
        '^환자(?:명)?\\s*[:：]\\s*(.+)$',
        '^성\\s*명\\s*[:：]\\s*(.+)$'
    ],
    prescriptionNoPattern: '\\b(20\\d{6}-\\d{3,6})\\b',
    skipLinePatterns: [
        '^\\s*$',
        '^[-=_]{3,}$',
        '^PDFCreator',
        '^Fast Report',
        '^©',
        '^Date:',
        '^Authors:',
        '^Homepage:',
        '^Computer:',
        '^Windows:',
        '^FREE$',
        '^The quick brown fox',
        '^ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    ]
};

function normalizeText(text) {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/총\s*투약\s*일\s*수/g, '총투약일수')
        .replace(/1\s*회\s*투약\s*량/g, '1회투약량')
        .replace(/1\s*일\s*투여\s*횟\s*수/g, '1일투여횟수')
        .trim();
}

function normalizeLine(line) {
    return line
        .replace(/([가-힣A-Za-z0-9])\s+([가-힣A-Za-z0-9])(?=[가-힣A-Za-z0-9]*시럽)/g, '$1$2')
        .replace(/[ \t]+/g, ' ')
        .trim();
}

function normalizeLines(text) {
    return normalizeText(text)
        .split('\n')
        .map((line) => normalizeLine(line))
        .filter((line) => line.length > 0);
}

function shouldSkipLine(line, skipPatterns) {
    return skipPatterns.some((pattern) => new RegExp(pattern, 'i').test(line));
}

function cleanDrugName(rawName) {
    let name = rawName.trim();
    name = name.replace(/^[\d,.\-]+\s*/, '');
    name = name.replace(/^\*+/, '');
    name = name.split(/[\(_]/)[0].trim();
    name = name.replace(/[\[\]{}<>]/g, '');
    name = name.replace(/\s+/g, '');
    return name.trim(' _-');
}

function isPatientNameLabel(text) {
    if (!text) return true;
    return /^(최근내방일|교부번호|발행기관|질병기호|조제약사|조제일|약품명|복약안내|복약만료일|님|외|성분)$/.test(text)
        || /[:：]/.test(text)
        || /(약품명|성분|교부|발행|질병|조제|복약|최근|만료일)/.test(text);
}

function linesSharePrescription(line, prescriptionNo) {
    if (!prescriptionNo || !line) return false;
    if (line.includes(prescriptionNo)) return true;

    const presMatch = prescriptionNo.match(/^(20\d{6})-0*(\d+)$/);
    const lineMatch = line.match(/(20\d{6})-0*(\d+)/);
    if (!presMatch || !lineMatch) return false;

    return presMatch[1] === lineMatch[1] && presMatch[2] === lineMatch[2];
}

function collectPrescriptionVariants(text) {
    const matches = [...text.matchAll(/\b(20\d{6}-0*\d+)\b/g)].map((m) => m[1]);
    return [...new Set(matches)].sort((a, b) => b.length - a.length);
}

function extractPatientNameTableFormat(lines, prescriptionNo) {
    const candidates = [];
    const presVariants = collectPrescriptionVariants(lines.join('\n'));
    if (prescriptionNo && !presVariants.includes(prescriptionNo)) {
        presVariants.unshift(prescriptionNo);
    }

    for (const presNo of presVariants) {
        for (let i = 0; i < lines.length; i++) {
            if (!linesSharePrescription(lines[i], presNo)) continue;

            for (const offset of [-3, -2, -1, 1, 2, 3]) {
                const idx = i + offset;
                if (idx < 0 || idx >= lines.length) continue;
                const candidate = lines[idx];
                if (/^[가-힣A-Za-z]{2,15}$/.test(candidate) && !isPatientNameLabel(candidate)) {
                    candidates.push({ name: candidate, distance: Math.abs(offset), lineIdx: i });
                }
            }
        }
    }

    for (let i = 0; i < lines.length; i++) {
        if (!/^20\d{6}-0*\d+$/.test(lines[i])) continue;
        for (const offset of [-3, -2, -1, 1, 2, 3]) {
            const idx = i + offset;
            if (idx < 0 || idx >= lines.length) continue;
            const candidate = lines[idx];
            if (/^[가-힣A-Za-z]{2,15}$/.test(candidate) && !isPatientNameLabel(candidate)) {
                candidates.push({ name: candidate, distance: Math.abs(offset), lineIdx: i });
            }
        }
    }

    if (candidates.length) {
        candidates.sort((a, b) => a.lineIdx - b.lineIdx || a.distance - b.distance);
        return candidates[0].name;
    }

    for (let i = 0; i < lines.length; i++) {
        if (/^\(\s*만\s*\d+\s*세\s*\/\s*[남여]\s*\)$/.test(lines[i])) {
            for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
                const candidate = lines[j];
                if (/^[가-힣A-Za-z]{2,15}$/.test(candidate) && !isPatientNameLabel(candidate)) {
                    return candidate;
                }
            }
        }
    }

    return null;
}

function extractPatientName(text, patterns, lines = null) {
    for (const pattern of patterns) {
        const match = text.match(new RegExp(pattern, 'i'));
        if (match && match[1]) {
            const name = match[1].trim();
            if (name.length >= 2 && name.length <= 20 && !isPatientNameLabel(name)) return name;
        }
    }

    const normalizedLines = lines || normalizeLines(text);
    const prescriptionNo = extractPrescriptionNo(normalizeText(text), DEFAULT_PARSER.prescriptionNoPattern);
    const tableName = extractPatientNameTableFormat(normalizedLines, prescriptionNo);
    if (tableName) return tableName;

    for (const line of normalizedLines) {
        const inlineName = line.match(/^([가-힣A-Za-z]{2,20})\s*\(\s*만\s*\d+\s*세/);
        if (inlineName && !isPatientNameLabel(inlineName[1])) {
            return inlineName[1].trim();
        }
    }

    return null;
}

function findColumnTableHeaderIndex(lines) {
    for (let i = 0; i < lines.length; i++) {
        const compact = lines[i].replace(/\s+/g, '');
        if (/일수.*횟수.*투약량.*약품명|투약량.*횟수.*일수|일수횟수투약량약품명/.test(compact)) {
            return i;
        }
    }
    return -1;
}

function mergeDrugLineChunks(rawLines) {
    const drugKeyword = new RegExp(DRUG_KEYWORD_PATTERN);
    const names = [];
    let buffer = '';

    const flushBuffer = () => {
        if (!buffer || !drugKeyword.test(buffer)) {
            buffer = '';
            return;
        }
        const cleaned = cleanDrugName(buffer);
        if (cleaned.length >= 2) names.push(cleaned);
        buffer = '';
    };

    for (const line of rawLines) {
        if (/^\d+(\.\d+)?$/.test(line) || isPatientNameLabel(line)) continue;

        if (!buffer && !drugKeyword.test(line)) continue;

        buffer += line;
        const openParen = (buffer.match(/\(/g) || []).length;
        const closeParen = (buffer.match(/\)/g) || []).length;

        if (drugKeyword.test(buffer) && (openParen <= closeParen || openParen === 0)) {
            flushBuffer();
        }
    }

    flushBuffer();
    return names;
}

function splitNumericMatrix(values) {
    if (values.length < 3) return null;

    for (let colCount = 1; colCount <= 12; colCount++) {
        if (values.length !== colCount * 3) continue;
        return {
            volumes: values.slice(0, colCount),
            dailies: values.slice(colCount, colCount * 2),
            periods: values.slice(colCount * 2, colCount * 3)
        };
    }

    return null;
}

function splitMergedDosageDrugLine(line) {
    const drugKeyword = new RegExp(DRUG_KEYWORD_PATTERN);
    const match = line.match(/^(\d+(?:\.\d+)?)(.+)$/);
    if (!match || !drugKeyword.test(match[2])) return null;

    const dosage = parseCompactDosage(match[1].split('.')[0]);
    if (!dosage || !dosage.volume || !dosage.daily || !dosage.period) return null;

    return {
        dosage,
        drugPart: match[2]
    };
}

function extractItemsColumnTable(lines) {
    const headerIdx = findColumnTableHeaderIndex(lines);
    if (headerIdx < 0) return [];

    let idx = headerIdx - 1;
    const drugRaw = [];
    const mergedItems = [];
    while (idx >= 0 && !/^\d+(\.\d+)?$/.test(lines[idx])) {
        const merged = splitMergedDosageDrugLine(lines[idx]);
        if (merged) {
            mergedItems.unshift(merged);
            idx--;
            continue;
        }
        drugRaw.unshift(lines[idx]);
        idx--;
    }

    if (mergedItems.length) {
        const items = [];
        for (const merged of mergedItems) {
            const names = mergeDrugLineChunks([merged.drugPart]);
            if (!names.length) continue;
            const { volume, daily, period } = merged.dosage;
            items.push({
                pill_code: '',
                pill_name: names[0],
                volume,
                daily,
                period,
                total: volume * daily * period,
                line_number: items.length + 1
            });
        }
        if (items.length) return items;
    }

    const numericValues = [];
    while (idx >= 0 && /^\d+(\.\d+)?$/.test(lines[idx])) {
        numericValues.unshift(parseFloat(lines[idx]));
        idx--;
    }

    const matrix = splitNumericMatrix(numericValues);
    if (!matrix) return [];

    const drugNames = mergeDrugLineChunks(drugRaw);
    const count = Math.min(
        drugNames.length,
        matrix.volumes.length,
        matrix.dailies.length,
        matrix.periods.length
    );

    const items = [];
    for (let i = 0; i < count; i++) {
        const volume = matrix.volumes[i];
        const daily = matrix.dailies[i];
        const period = matrix.periods[i];
        if (!volume || !daily || !period) continue;

        items.push({
            pill_code: '',
            pill_name: drugNames[i],
            volume,
            daily,
            period,
            total: volume * daily * period,
            line_number: items.length + 1
        });
    }

    return items;
}

function extractPrescriptionNo(text, pattern) {
    const matches = [...text.matchAll(new RegExp(pattern, 'g'))].map((m) => m[1]);
    if (!matches.length) return null;
    matches.sort((a, b) => b.length - a.length);
    return matches[0];
}

function extractReceiptDate(text, prescriptionNo, filePath) {
    if (prescriptionNo) {
        const datePart = prescriptionNo.substring(0, 8);
        if (/^20\d{6}$/.test(datePart)) {
            return `${datePart.substring(0, 4)}-${datePart.substring(4, 6)}-${datePart.substring(6, 8)}`;
        }
    }

    const contentDate = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (contentDate) return contentDate[1];

    const fileName = filePath ? pathBasename(filePath) : '';
    const fileDate = fileName.match(/(20\d{2}-\d{2}-\d{2})/);
    if (fileDate) return fileDate[1];

    const compactDate = text.match(/\b(20\d{6})\b/);
    if (compactDate) {
        const d = compactDate[1];
        return `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`;
    }

    return null;
}

function pathBasename(filePath) {
    return filePath.split(/[\\/]/).pop() || '';
}

function parseCompactDosage(value) {
    const digits = String(value).trim();
    if (!/^\d{3,4}$/.test(digits)) return null;

    if (digits.length === 3) {
        return {
            volume: parseInt(digits[0], 10),
            daily: parseInt(digits[1], 10),
            period: parseInt(digits[2], 10)
        };
    }

    // 4자리: 앞 2자리가 1회투약량(10~99), 뒤 1자리씩
    const volume = parseInt(digits.slice(0, 2), 10);
    const daily = parseInt(digits[2], 10);
    const period = parseInt(digits[3], 10);
    if (volume >= 10 && daily > 0 && period > 0) {
        return { volume, daily, period };
    }

    return {
        volume: parseInt(digits[0], 10),
        daily: parseInt(digits[1], 10),
        period: parseInt(digits.slice(2), 10)
    };
}

function extractDosageFromFollowingLines(lines, startIdx, maxLookahead = 15) {
    let volume;
    let daily;
    let period;

    for (let i = startIdx; i < Math.min(startIdx + maxLookahead, lines.length); i++) {
        const line = lines[i];

        const volInline = line.match(/1회투약량\s*(\d+(?:\.\d+)?)/);
        if (volInline) volume = parseFloat(volInline[1]);

        const freqInline = line.match(/1일투여횟수\s*(\d+(?:\.\d+)?)/);
        if (freqInline) daily = parseFloat(freqInline[1]);

        const daysInline = line.match(/총투약일수\s*(\d+(?:\.\d+)?)/);
        if (daysInline) period = parseFloat(daysInline[1]);

        if (/^1회투약량\s*$/.test(line) && i + 1 < lines.length) {
            const value = lines[i + 1].match(/^(\d+(?:\.\d+)?)/);
            if (value) volume = parseFloat(value[1]);
        }
        if (/^1일투여횟수\s*$/.test(line) && i + 1 < lines.length) {
            const value = lines[i + 1].match(/^(\d+(?:\.\d+)?)/);
            if (value) daily = parseFloat(value[1]);
        }
        if (/^총투약일수\s*$/.test(line) && i + 1 < lines.length) {
            const value = lines[i + 1].match(/^(\d+(?:\.\d+)?)/);
            if (value) period = parseFloat(value[1]);
        }

        if (volume > 0 && daily > 0 && period > 0) {
            return { volume, daily, period };
        }
    }

    return null;
}

function extractItemsPerDrugBlock(lines) {
    const drugKeyword = new RegExp(DRUG_KEYWORD_PATTERN);
    const items = [];
    const seen = new Set();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!drugKeyword.test(line) || line.includes('1회투약량')) continue;
        if (shouldSkipLine(line, ['^적색', '^투명', '^실온', '^냉장', '^백색'])) continue;

        const pillName = cleanDrugName(line);
        if (!pillName || pillName.length < 2) continue;

        const dose = extractDosageFromFollowingLines(lines, i + 1);
        if (!dose) continue;

        const key = `${pillName}|${dose.volume}|${dose.daily}|${dose.period}`;
        if (seen.has(key)) continue;
        seen.add(key);

        items.push({
            pill_code: '',
            pill_name: pillName,
            volume: dose.volume,
            daily: dose.daily,
            period: dose.period,
            total: dose.volume * dose.daily * dose.period,
            line_number: items.length + 1
        });
    }

    return items;
}

function extractMedicinesByLayout(lines, layout) {
    switch (layout) {
        case 'column_table':
            return extractItemsColumnTable(lines);
        case 'per_drug_block':
            return extractItemsPerDrugBlock(lines);
        case 'inline':
            return extractItemsInline(lines);
        case 'compact_next_line':
        case 'fastreport':
            return extractItemsFastReport(lines);
        default:
            return extractItemsPerDrugBlock(lines);
    }
}

function finalizeBagParseResult({ patientName, prescriptionNo, receiptDate, medicines, parserUsed, rawText }) {
    const dateCompact = receiptDate ? receiptDate.replace(/-/g, '') : '';
    medicines.forEach((med, index) => {
        if (!med.line_number) med.line_number = index + 1;
        if (!med.date && dateCompact) med.date = dateCompact;
        if (!med.total) med.total = med.volume * med.daily * med.period;
    });

    return {
        patientName: patientName || '미확인',
        prescriptionNo,
        receiptDate,
        medicines,
        parseSuccess: Boolean(patientName && medicines.length > 0),
        parserUsed,
        rawText
    };
}

function parseBagTextWithTemplate(text, template, filePath = '') {
    const normalized = normalizeText(text);
    const lines = normalizeLines(text);
    const patientPatterns = template.patientNamePatterns || DEFAULT_PARSER.patientNamePatterns;
    const prescriptionPattern = template.prescriptionNoPattern || DEFAULT_PARSER.prescriptionNoPattern;

    if (isTestPdf(normalized)) {
        return {
            patientName: null,
            prescriptionNo: null,
            receiptDate: null,
            medicines: [],
            parseSuccess: false,
            parserUsed: 'test_skip',
            rawText: text
        };
    }

    const patientName = extractPatientName(normalized, patientPatterns, lines);
    const prescriptionNo = extractPrescriptionNo(normalized, prescriptionPattern);
    const receiptDate = extractReceiptDate(normalized, prescriptionNo, filePath);
    const layout = template.dosageLayout || 'per_drug_block';

    const tryLayouts = [layout, 'column_table', 'per_drug_block', 'fastreport', 'inline'];
    const uniqueLayouts = [...new Set(tryLayouts)];

    let medicines = [];
    let parserUsed = 'template_none';
    for (const candidate of uniqueLayouts) {
        const found = extractMedicinesByLayout(lines, candidate);
        if (found.length > medicines.length) {
            medicines = found;
            parserUsed = `template_${candidate}`;
        }
    }

    return finalizeBagParseResult({
        patientName,
        prescriptionNo,
        receiptDate,
        medicines,
        parserUsed,
        rawText: text
    });
}

function extractItemsInline(lines) {
    const items = [];
    const seen = new Set();
    const pattern = new RegExp(
        `(?<drug>[^\\n]*?${DRUG_KEYWORD_PATTERN}[^\\n]*?)\\s+` +
        '1회투약량\\s*(?<dose>\\d+(?:\\.\\d+)?)\\s*' +
        '1일투여횟수\\s*(?<freq>\\d+(?:\\.\\d+)?)\\s*' +
        '총투약일수\\s*(?<days>\\d+(?:\\.\\d+)?)',
        'gi'
    );

    for (const line of lines) {
        let match;
        while ((match = pattern.exec(line)) !== null) {
            const pillName = cleanDrugName(match.groups.drug);
            const volume = parseFloat(match.groups.dose);
            const daily = parseFloat(match.groups.freq);
            const period = parseFloat(match.groups.days);
            if (!pillName || !volume || !daily || !period) continue;

            const key = `${pillName}|${volume}|${daily}|${period}`;
            if (seen.has(key)) continue;
            seen.add(key);

            items.push({
                pill_code: '',
                pill_name: pillName,
                volume,
                daily,
                period,
                total: Math.round(volume * daily * period * 1000) / 1000,
                line_number: items.length + 1
            });
        }
    }

    return items;
}

function extractItemsFastReport(lines) {
    const drugKeyword = new RegExp(DRUG_KEYWORD_PATTERN);
    const drugNames = [];
    const dosages = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (drugKeyword.test(line) && !line.includes('1회투약량') && !shouldSkipLine(line, ['^적색', '^투명', '^실온', '^냉장'])) {
            const cleaned = cleanDrugName(line);
            if (cleaned && cleaned.length >= 2) drugNames.push(cleaned);
        }

        if (/^\d{8}$/.test(line)) {
            continue;
        }

        if (line.includes('1회투약량') && line.includes('1일투여횟수') && line.includes('총투약일수')) {
            const inlineMatch = line.match(
                /1회투약량\s*(\d+(?:\.\d+)?)\s*1일투여횟수\s*(\d+(?:\.\d+)?)\s*총투약일수\s*(\d+(?:\.\d+)?)/
            );
            if (inlineMatch) {
                dosages.push({
                    volume: parseFloat(inlineMatch[1]),
                    daily: parseFloat(inlineMatch[2]),
                    period: parseFloat(inlineMatch[3])
                });
                continue;
            }

            if (i + 1 < lines.length) {
                const next = lines[i + 1];
                const compact = parseCompactDosage(next);
                if (compact && compact.volume > 0 && compact.daily > 0 && compact.period > 0) {
                    dosages.push(compact);
                    i++;
                }
            }
        }
    }

    if (!drugNames.length || !dosages.length) return [];

    const count = Math.min(drugNames.length, dosages.length);
    const items = [];

    for (let i = 0; i < count; i++) {
        const dose = dosages[i];
        items.push({
            pill_code: '',
            pill_name: drugNames[i],
            volume: dose.volume,
            daily: dose.daily,
            period: dose.period,
            total: dose.volume * dose.daily * dose.period,
            line_number: i + 1
        });
    }

    return items;
}

function extractItemsGeneric(lines) {
    const items = [];
    for (const line of lines) {
        const backslashMatch = line.match(
            /^(\d{6,12})\\(.+?)\\(\d+)\\(\d+)\\(\d+)\\(\d+)\\(\d{8})\\(\d+)/
        );
        if (backslashMatch) {
            items.push({
                pill_code: backslashMatch[1],
                pill_name: backslashMatch[2],
                volume: parseInt(backslashMatch[3], 10) || 0,
                daily: parseInt(backslashMatch[4], 10) || 0,
                period: parseInt(backslashMatch[5], 10) || 0,
                total: parseInt(backslashMatch[6], 10) || 0,
                date: backslashMatch[7],
                line_number: parseInt(backslashMatch[8], 10) || items.length + 1
            });
            continue;
        }

        const spacedMatch = line.match(
            /^(\d{6,12})\s+(.+?)\s+(\d+)\s*(?:ml|mL|ML)?\s*[x×*]\s*(\d+)\s*(?:회|times)?\s*[x×*]\s*(\d+)\s*(?:일|days)?(?:\s*[=\\-]?\s*(\d+)\s*(?:ml|mL|ML)?)?/i
        );
        if (spacedMatch) {
            const volume = parseInt(spacedMatch[3], 10) || 0;
            const daily = parseInt(spacedMatch[4], 10) || 0;
            const period = parseInt(spacedMatch[5], 10) || 0;
            items.push({
                pill_code: spacedMatch[1],
                pill_name: spacedMatch[2].trim(),
                volume,
                daily,
                period,
                total: spacedMatch[6] ? parseInt(spacedMatch[6], 10) : volume * daily * period,
                line_number: items.length + 1
            });
        }
    }
    return items;
}

function isTestPdf(text) {
    return /PDFCreator|pdfforge|Testpage|quick brown fox/i.test(text);
}

function parseBagText(text, parserConfig = DEFAULT_PARSER, filePath = '') {
    const config = { ...DEFAULT_PARSER, ...parserConfig };

    if (config.customTemplate) {
        const templateResult = parseBagTextWithTemplate(text, config.customTemplate, filePath);
        if (templateResult.parseSuccess) {
            return templateResult;
        }
    }

    const normalized = normalizeText(text);
    const lines = normalizeLines(text);

    if (isTestPdf(normalized)) {
        return {
            patientName: null,
            prescriptionNo: null,
            receiptDate: null,
            medicines: [],
            parseSuccess: false,
            parserUsed: 'test_skip',
            rawText: text
        };
    }

    const patientName = extractPatientName(normalized, config.patientNamePatterns || [], lines);
    const prescriptionNo = extractPrescriptionNo(normalized, config.prescriptionNoPattern);
    const receiptDate = extractReceiptDate(normalized, prescriptionNo, filePath);

    const strategies = [
        ['column_table', extractItemsColumnTable],
        ['per_drug_block', extractItemsPerDrugBlock],
        ['fastreport', extractItemsFastReport],
        ['inline', extractItemsInline],
        ['generic', extractItemsGeneric]
    ];

    if (config.profile === 'fastreport') {
        strategies.unshift(['fastreport', extractItemsFastReport]);
    } else if (config.profile === 'inline') {
        strategies.unshift(['inline', extractItemsInline]);
    }

    const seen = new Set();
    let medicines = [];
    let parserUsed = 'none';
    for (const [name, fn] of strategies) {
        if (seen.has(name)) continue;
        seen.add(name);
        const found = fn(lines);
        if (found.length > medicines.length) {
            medicines = found;
            parserUsed = name;
        }
    }

    return finalizeBagParseResult({
        patientName,
        prescriptionNo,
        receiptDate,
        medicines,
        parserUsed,
        rawText: text
    });
}

async function parsePdfFile(pdfPath, parserConfig) {
    return enqueuePdfParse(async () => {
        configurePdfJsForElectron();
        const buffer = fs.readFileSync(pdfPath);
        const result = await pdfParse(buffer);
        return parseBagText(result.text || '', parserConfig, pdfPath);
    });
}

let parseQueue = Promise.resolve();

function enqueuePdfParse(task) {
    const run = parseQueue.then(task, task);
    parseQueue = run.catch(() => {});
    return run;
}

function extractReceiptNumberFromPdfPath(filePath, parsed) {
    if (parsed.prescriptionNo) {
        return parsed.prescriptionNo.replace(/[^\w\-]/g, '');
    }

    const baseName = pathBasename(filePath).replace(/\.pdf$/i, '');
    const prescriptionInName = baseName.match(/(20\d{6}-\d{3,6})/);
    if (prescriptionInName) return prescriptionInName[1];

    const timestamp = baseName.match(/(20\d{2}-\d{2}-\d{2})/);
    if (timestamp) {
        const timePart = baseName.match(/(오전|오후)\s*(\d+)_(\d+)_(\d+)/);
        if (timePart) {
            const compact = timestamp[1].replace(/-/g, '');
            const hh = timePart[2].padStart(2, '0');
            const mm = timePart[3].padStart(2, '0');
            const ss = timePart[4].padStart(2, '0');
            return `${compact}${hh}${mm}${ss}`;
        }
        return baseName.replace(/[^\w\-가-힣]/g, '_').slice(0, 40);
    }

    return baseName.replace(/[^\w\-가-힣]/g, '_').slice(0, 40);
}

module.exports = {
    parsePdfFile,
    parseBagText,
    parseBagTextWithTemplate,
    extractReceiptNumberFromPdfPath,
    extractPatientName,
    extractPrescriptionNo,
    extractReceiptDate,
    extractItemsColumnTable,
    extractItemsColumnTable,
    extractItemsPerDrugBlock,
    extractItemsFastReport,
    extractItemsInline,
    findColumnTableHeaderIndex,
    normalizeText,
    normalizeLines,
    cleanDrugName,
    DRUG_KEYWORD_PATTERN,
    DEFAULT_PARSER
};
