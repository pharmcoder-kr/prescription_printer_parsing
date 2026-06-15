const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { parsePdfFile } = require('./src/pdfBagParser');

const dir = 'C:/AutoSyrup/PDF';

async function dump(namePart) {
    const file = fs.readdirSync(dir).find(f => f.includes(namePart) && f.endsWith('.pdf'));
    const full = path.join(dir, file);
    const buf = fs.readFileSync(full);
    const raw = await pdfParse(buf);
    const parsed = await parsePdfFile(full, null);
    console.log('\n====', file, '====');
    console.log('parseSuccess:', parsed.parseSuccess, 'patient:', parsed.patientName, 'meds:', parsed.medicines.length, 'parser:', parsed.parserUsed);
    console.log('TEXT:\n', raw.text);
}

(async () => {
    await dump('10_22_05');
    await dump('9_42_01');
})();
