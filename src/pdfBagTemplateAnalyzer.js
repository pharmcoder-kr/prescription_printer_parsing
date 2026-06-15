const {
    DEFAULT_PARSER,
    normalizeText,
    normalizeLines,
    extractPatientName,
    extractPrescriptionNo,
    extractReceiptDate,
    finalizeBagParseResult,
    isTestPdf,
    parseBagTextWithTemplate
} = require('./pdfBagParser');
const {
    learnBagTemplate,
    parseBagTextWithLearnedTemplate,
    scoreLearnedTemplate
} = require('./pdfBagTemplateLearner');

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

    const patientName = extractPatientName(normalized, DEFAULT_PARSER.patientNamePatterns, lines);
    const prescriptionNo = extractPrescriptionNo(normalized, DEFAULT_PARSER.prescriptionNoPattern);
    const receiptDate = extractReceiptDate(normalized, prescriptionNo, fileName);

    const learnedTemplate = learnBagTemplate(normalized, fileName);
    if (learnedTemplate) {
        const { score, result } = scoreLearnedTemplate(normalized, learnedTemplate, fileName);
        if (score > 0 && result.medicines.length > 0) {
            return {
                template: learnedTemplate,
                preview: {
                    patientName: result.patientName,
                    prescriptionNo: result.prescriptionNo,
                    receiptDate: result.receiptDate,
                    medicines: result.medicines,
                    parseSuccess: result.parseSuccess,
                    parserUsed: result.parserUsed
                },
                detectedFields: {
                    patientName,
                    prescriptionNo,
                    receiptDate,
                    lineCount: lines.length,
                    learnedStrategy: learnedTemplate.learned.strategy
                }
            };
        }
    }

    const layoutScores = {};
    const DOSAGE_LAYOUTS = ['ubcare_table', 'column_table', 'per_drug_block', 'inline', 'compact_next_line', 'fastreport'];
    for (const layout of DOSAGE_LAYOUTS) {
        const template = {
            templateVersion: 1,
            dosageLayout: layout,
            patientNamePatterns: DEFAULT_PARSER.patientNamePatterns,
            prescriptionNoPattern: DEFAULT_PARSER.prescriptionNoPattern
        };
        const result = parseBagTextWithTemplate(normalized, template, fileName);
        layoutScores[layout] = scoreParseResult(result);
    }

    const bestLayout = Object.entries(layoutScores)
        .sort((a, b) => b[1] - a[1])[0][0];

    const template = {
        templateVersion: 1,
        sourceFileName: fileName,
        registeredAt: new Date().toISOString(),
        dosageLayout: bestLayout,
        patientNamePatterns: DEFAULT_PARSER.patientNamePatterns,
        prescriptionNoPattern: DEFAULT_PARSER.prescriptionNoPattern,
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
    learnBagTemplate,
    parseBagTextWithLearnedTemplate
};
