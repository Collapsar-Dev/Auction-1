/** Генератор демо-фото (SVG) для сида: дом или квартира в разных цветах. */
const PALETTES = [
  ['#f4d9b0', '#c96f3b', '#7aa6c2'],
  ['#dfe9d8', '#8a5a44', '#9cc3a5'],
  ['#e9e1f2', '#5b4e7a', '#c9b8e3'],
  ['#f6e6c8', '#a24d2b', '#f0b45e'],
  ['#d9e7ef', '#3c5a75', '#86b1cf'],
  ['#efe4dc', '#7c4b3a', '#d6a58a'],
];

export function demoPhoto(kind: 'house' | 'apartment', seed: number, index: number, label: string) {
  const [bg, main, accent] = PALETTES[(seed + index) % PALETTES.length];
  const view = index % 4;
  const sky = `<rect width="800" height="600" fill="${bg}"/><circle cx="${650 - index * 20}" cy="110" r="46" fill="#fff" opacity=".7"/>`;
  const ground = `<rect y="470" width="800" height="130" fill="${accent}" opacity=".55"/>`;
  let body = '';
  if (view === 3) {
    // интерьер
    body = `<rect x="0" y="0" width="800" height="600" fill="${bg}"/><rect x="0" y="420" width="800" height="180" fill="${main}" opacity=".35"/>
      <rect x="470" y="110" width="220" height="200" fill="#fff" stroke="${main}" stroke-width="10"/><line x1="580" y1="110" x2="580" y2="310" stroke="${main}" stroke-width="6"/>
      <rect x="90" y="300" width="300" height="130" rx="18" fill="${accent}"/><rect x="90" y="260" width="300" height="60" rx="18" fill="${main}" opacity=".7"/>
      <rect x="430" y="380" width="160" height="16" fill="${main}"/><rect x="450" y="396" width="10" height="60" fill="${main}"/><rect x="560" y="396" width="10" height="60" fill="${main}"/>`;
  } else if (kind === 'house') {
    const w = 360 + view * 40;
    const x = 400 - w / 2;
    body = `${sky}${ground}<rect x="${x}" y="270" width="${w}" height="220" fill="${main}"/>
      <polygon points="${x - 30},280 400,${150 - view * 10} ${x + w + 30},280" fill="#5a3b2e"/>
      <rect x="${x + 40}" y="320" width="70" height="70" fill="#fff" opacity=".9"/><rect x="${x + w - 110}" y="320" width="70" height="70" fill="#fff" opacity=".9"/>
      <rect x="${370}" y="380" width="60" height="110" fill="#3b2a22"/>
      <rect x="${x - 120}" y="430" width="16" height="60" fill="#6b4a32"/><circle cx="${x - 112}" cy="410" r="45" fill="#5f8f5a"/>`;
  } else {
    const floors = 6 + (seed % 5);
    let win = '';
    for (let f = 0; f < floors; f++) for (let c = 0; c < 5; c++) win += `<rect x="${250 + c * 62}" y="${110 + f * (340 / floors)}" width="34" height="${Math.max(16, 340 / floors - 22)}" fill="#fff" opacity="${(f + c + index) % 3 ? 0.9 : 0.55}"/>`;
    body = `${sky}${ground}<rect x="225" y="90" width="350" height="400" fill="${main}"/>${win}<rect x="370" y="430" width="60" height="60" fill="#2c2c2c"/>
      <rect x="600" y="230" width="140" height="260" fill="${main}" opacity=".6"/><rect x="60" y="270" width="140" height="220" fill="${main}" opacity=".45"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">${body}
    <rect x="20" y="545" rx="8" width="${Math.max(120, label.length * 11 + 30)}" height="38" fill="#000" opacity=".45"/>
    <text x="36" y="571" font-family="Arial, sans-serif" font-size="20" fill="#fff">${label} · ${index + 1}</text></svg>`;
}

/** Минимальный PDF-заглушка «выписка из кадастра». */
export function demoPdf(text: string) {
  const content = `BT /F1 18 Tf 60 760 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}
