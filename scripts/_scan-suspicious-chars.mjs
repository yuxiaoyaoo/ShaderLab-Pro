import fs from 'node:fs';

const buf = fs.readFileSync('F:/ShaderLab Pro/code.txt');
const s = buf.toString('utf8');
const lines = s.split('\n');
let found = 0;
lines.forEach((line, i) => {
  const chars = [...line];
  chars.forEach((ch, j) => {
    const cp = ch.codePointAt(0);
    if (cp > 127 || (cp < 32 && cp !== 13 && cp !== 9)) {
      console.log(`Line ${i + 1} Col ${j + 1} U+${cp.toString(16).toUpperCase().padStart(4, '0')} [${ch}]`);
      found++;
    }
  });
});
console.log('CRLF count:', (s.match(/\r\n/g) || []).length);
console.log('bare CR count:', (s.match(/\r(?!\n)/g) || []).length);
console.log('total suspicious chars:', found);
