const {
    DEFAULT_PARSER,
    normalizeText,
    normalizeLines,
    cleanDrugName,
    DRUG_KEYWORD_PATTERN,
    extractPatientName,
    extractPrescriptionNo,
    extractReceiptDate,
    extractItemsColumnTable,
    extractItemsPerDrugBlock,
    extractItemsFastReport,
    extractItemsInline,
    parseBagTextWithTemplate,
    findColumnTableHeaderIndex
} = require('./pdfBagParser');

const DOSAGE_LAYOUTS = ['column_table', 'per_drug_block', 'inline', 'compact_next_line', 'fastreport'];

function detectDosageLayout(lines) {
    const joined = lines.join('\n');

    if (findColumnTableHeaderIndex(lines) >= 0) {
        return 'column_table';
    }

    for (const line of lines) {
        if (line.includes('1회투약량') && line.includes('1일투여횟수') && line.includes('총투약일수')) {
            return 'inline';
        }
    }

    if (/1회투약량[\s\n]+\d+[\s\n]+1일투여횟수[\s\n]+\d+[\s\n]+총투약일수[\s\n]+\d+/i.test(joined)) {
        return 'per_drug_block';
    }

    for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i].includes('1회투약량') && lines[i].includes('1일투여횟수') && lines[i].includes('총투약일수')) {
            if (/^\d{3,4}$/.test(lines[i + 1])) {
                return 'compact_next_line';
            }
        }
    }

    if (/1회투약량/i.test(joined) && /1일투여횟수/i.test(joined) && /총투약일수/i.test(joined)) {
        return 'per_drug_block';
    }

    return 'fastreport';
}

function scoreParseResult(result) {
    if (!result) return 0;
    let score = 0;
    if (result.patientName && result.patientName !== '미확인') score += 3;
    if (result.prescriptionNo) score += 2;
    score += (result.medicines || []).length * 5;
    return score;
}

function analyzeBagTemplate(text, fileName = '') {
    const normalized = normalizeText(text);
    const lines = normalizeLines(text);

    const patientName = extractPatientName(normalized, DEFAULT_PARSER.patientNamePatterns);
    const prescriptionNo = extractPrescriptionNo(normalized, DEFAULT_PARSER.prescriptionNoPattern);
    const receiptDate = extractReceiptDate(normalized, prescriptionNo, fileName);

    const layoutScores = {};
    for (const layout of DOSAGE_LAYOUTS) {
        const template = {
            templateVersion: 1,
            dosageLayout: layout,
            patientNamePatterns: DEFAULT_PARSER.patientNamePatterns,
            prescriptionNoPattern: DEFAULT_PARSER.prescriptionNoPattern,
            drugKeywordPattern: DRUG_KEYWORD_PATTERN
        };
        const result = parseBagTextWithTemplate(normalized, template, fileName);
        layoutScores[layout] = scoreParseResult(result);
    }

    const bestLayout = Object.entries(layoutScores)
        .sort((a, b) => b[1] - a[1])[0][0];

    const detectedLayout = detectDosageLayout(lines);
    const dosageLayout = layoutScores[detectedLayout] >= layoutScores[bestLayout]
        ? detectedLayout
        : bestLayout;

    const template = {
        templateVersion: 1,
        sourceFileName: fileName,
        registeredAt: new Date().toISOString(),
        dosageLayout,
        patientNamePatterns: DEFAULT_PARSER.patientNamePatterns,
        prescriptionNoPattern: DEFAULT_PARSER.prescriptionNoPattern,
        drugKeywordPattern: DRUG_KEYWORD_PATTERN,
        layoutScores
    };

    const preview = parseBagTextWithTemplate(normalized, template, fileName);

    return {
        template,
        preview: {
            patientName: preview.patientName,
            prescriptionNo: preview.prescriptionNo,
            receiptDate: preview.receiptDate,
            medicines: preview.medicines,
            parseSuccess: preview.parseSuccess,
            parserUsed: preview.parserUsed
        },
        detectedFields: {
            patientName,
            prescriptionNo,
            receiptDate,
            lineCount: lines.length
        }
    };
}

function buildParserConfigFromTemplate(template, baseConfig = {}) {
    if (!template) return { ...DEFAULT_PARSER, ...baseConfig };
    return {
        ...DEFAULT_PARSER,
        ...baseConfig,
        customTemplate: template,
        patientNamePatterns: template.patientNamePatterns || DEFAULT_PARSER.patientNamePatterns,
        prescriptionNoPattern: template.prescriptionNoPattern || DEFAULT_PARSER.prescriptionNoPattern
    };
}

module.exports = {
    analyzeBagTemplate,
    buildParserConfigFromTemplate,
    detectDosageLayout
};
