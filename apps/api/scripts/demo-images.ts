/**
 * Генератор демо-фото (SVG) для сида: разные комнаты и виды объекта.
 * Каждый лот получает свой набор: фасад, гостиная, кухня, спальни, санузел, вид и т.д.
 */
const PALETTES = [
  { wall: '#efe6d8', floor: '#b98a5e', accent: '#c96f3b', fabric: '#7aa6c2', sky: '#cfe3f1' },
  { wall: '#e6ece3', floor: '#9b7653', accent: '#8a5a44', fabric: '#9cc3a5', sky: '#d8e8f0' },
  { wall: '#ece6f1', floor: '#a7825f', accent: '#5b4e7a', fabric: '#c9b8e3', sky: '#dde5f3' },
  { wall: '#f4ead7', floor: '#c49a6c', accent: '#a24d2b', fabric: '#f0b45e', sky: '#d4e6f5' },
  { wall: '#e3ebf0', floor: '#8f7258', accent: '#3c5a75', fabric: '#86b1cf', sky: '#d2e4f2' },
  { wall: '#f1e7e0', floor: '#b48a6b', accent: '#7c4b3a', fabric: '#d6a58a', sky: '#d9e7ef' },
];

export const APARTMENT_ROOMS = ['facade', 'living', 'kitchen', 'bedroom', 'bedroom2', 'bathroom', 'hallway', 'balcony', 'view', 'plan'] as const;
export const HOUSE_ROOMS = ['facade', 'yard', 'living', 'kitchen', 'bedroom', 'bathroom', 'terrace', 'bedroom2', 'garage', 'plan'] as const;
export type Room = (typeof APARTMENT_ROOMS)[number] | (typeof HOUSE_ROOMS)[number];

export const ROOM_LABEL: Record<Room, string> = {
  facade: 'Фасад · Facade',
  yard: 'Двор и сад · Garden',
  living: 'Гостиная · Living room',
  kitchen: 'Кухня · Kitchen',
  bedroom: 'Спальня · Bedroom',
  bedroom2: 'Детская · Kids room',
  bathroom: 'Санузел · Bathroom',
  hallway: 'Прихожая · Hallway',
  balcony: 'Балкон · Balcony',
  terrace: 'Терраса · Terrace',
  garage: 'Гараж · Garage',
  view: 'Вид из окна · View',
  plan: 'Планировка · Floor plan',
};

const win = (x: number, y: number, w: number, h: number, sky: string) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${sky}" stroke="#fff" stroke-width="10"/><line x1="${x + w / 2}" y1="${y}" x2="${x + w / 2}" y2="${y + h}" stroke="#fff" stroke-width="6"/><rect x="${x - 14}" y="${y - 8}" width="${w * 0.35}" height="${h + 30}" fill="#fff" opacity=".55"/>`;
const plant = (x: number, y: number) =>
  `<rect x="${x - 16}" y="${y}" width="32" height="40" rx="4" fill="#8a5a3c"/><circle cx="${x}" cy="${y - 18}" r="26" fill="#5f8f5a"/><circle cx="${x - 18}" cy="${y - 4}" r="16" fill="#6fa067"/><circle cx="${x + 18}" cy="${y - 6}" r="16" fill="#4f7f4a"/>`;
const room = (p: (typeof PALETTES)[number], inner: string) =>
  `<rect width="800" height="600" fill="${p.wall}"/><rect y="440" width="800" height="160" fill="${p.floor}"/>` +
  Array.from({ length: 9 }, (_, i) => `<line x1="${i * 100}" y1="440" x2="${i * 100 - 60}" y2="600" stroke="#000" opacity=".06" stroke-width="3"/>`).join('') +
  `<rect y="432" width="800" height="10" fill="#fff" opacity=".6"/>${inner}`;

function scene(r: Room, kind: 'house' | 'apartment', p: (typeof PALETTES)[number], seed: number) {
  switch (r) {
    case 'facade':
      if (kind === 'house')
        return `<rect width="800" height="600" fill="${p.sky}"/><circle cx="650" cy="110" r="46" fill="#fff" opacity=".8"/><rect y="470" width="800" height="130" fill="#7fae6b"/>
          <rect x="190" y="260" width="420" height="230" fill="${p.wall}" stroke="${p.accent}" stroke-width="4"/><polygon points="160,270 400,${130 - (seed % 3) * 10} 640,270" fill="${p.accent}"/>
          ${win(230, 310, 90, 80, p.sky)}${win(480, 310, 90, 80, p.sky)}<rect x="365" y="380" width="70" height="110" fill="#5a3b2e"/><circle cx="423" cy="438" r="5" fill="#e8c26a"/>
          <rect x="40" y="420" width="18" height="70" fill="#6b4a32"/><circle cx="49" cy="395" r="50" fill="#5f8f5a"/>${plant(680, 450)}<rect x="350" y="490" width="100" height="110" fill="#d9cbb5"/>`;
      return `<rect width="800" height="600" fill="${p.sky}"/><rect y="500" width="800" height="100" fill="#9aa59a"/>
        <rect x="210" y="70" width="380" height="430" fill="${p.wall}" stroke="${p.accent}" stroke-width="4"/>` +
        Array.from({ length: 7 }, (_, f) => Array.from({ length: 5 }, (_, c) => `<rect x="${236 + c * 70}" y="${92 + f * 55}" width="44" height="36" fill="${p.sky}" stroke="${p.accent}" stroke-width="3"/>${c % 2 ? `<rect x="${230 + c * 70}" y="${128 + f * 55}" width="56" height="6" fill="${p.accent}"/>` : ''}`).join('')).join('') +
        `<rect x="365" y="430" width="70" height="70" fill="#3b3b3b"/><rect x="30" y="250" width="160" height="250" fill="${p.fabric}" opacity=".5"/><rect x="610" y="190" width="160" height="310" fill="${p.accent}" opacity=".35"/>`;
    case 'yard':
      return `<rect width="800" height="600" fill="${p.sky}"/><rect y="330" width="800" height="270" fill="#86b46f"/><path d="M0 330 Q200 300 400 330 T800 320 V600 H0Z" fill="#79a862"/>
        <rect x="380" y="330" width="40" height="270" fill="#d9cbb5"/>${[120, 230, 580, 690].map((x, i) => `<rect x="${x - 8}" y="${260 + i * 6}" width="16" height="80" fill="#6b4a32"/><circle cx="${x}" cy="${240 + i * 6}" r="${46 - i * 4}" fill="${i % 2 ? '#5f8f5a' : '#4f7f4a'}"/>`).join('')}
        ${[0, 1, 2, 3, 4, 5].map((i) => `<circle cx="${150 + i * 90}" cy="${470 + (i % 2) * 30}" r="10" fill="${i % 2 ? '#e8c26a' : '#e07a7a'}"/>`).join('')}
        <rect x="560" y="420" width="140" height="10" fill="#8a5a3c"/><rect x="570" y="430" width="8" height="40" fill="#8a5a3c"/><rect x="682" y="430" width="8" height="40" fill="#8a5a3c"/>`;
    case 'living':
      return room(
        p,
        `${win(500, 110, 220, 210, p.sky)}<rect x="70" y="330" width="330" height="120" rx="20" fill="${p.fabric}"/><rect x="70" y="285" width="330" height="70" rx="18" fill="${p.fabric}" opacity=".85"/>
        <rect x="95" y="300" width="70" height="50" rx="10" fill="${p.accent}" opacity=".7"/><rect x="300" y="300" width="70" height="50" rx="10" fill="#fff" opacity=".7"/>
        <rect x="150" y="480" width="200" height="16" rx="6" fill="#5a3b2e"/><rect x="100" y="455" width="320" height="110" rx="10" fill="#fff" opacity=".18"/>
        <rect x="120" y="110" width="160" height="110" fill="#fff" stroke="${p.accent}" stroke-width="8"/><path d="M130 205 L180 150 L215 185 L240 160 L270 205Z" fill="${p.fabric}"/>
        ${kind === 'house' ? `<rect x="430" y="300" width="60" height="140" fill="#9a8b7a"/><rect x="440" y="370" width="40" height="60" fill="#2b2b2b"/><path d="M448 425 Q460 395 472 425Z" fill="#f0a24a"/>` : ''}${plant(740, 400)}
        <line x1="400" y1="0" x2="400" y2="60" stroke="#333" stroke-width="3"/><circle cx="400" cy="72" r="18" fill="#f6d77a"/>`,
      );
    case 'kitchen':
      return room(
        p,
        `<rect x="40" y="300" width="720" height="140" fill="#fff"/>${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="${50 + i * 118}" y="315" width="108" height="115" fill="${p.fabric}" stroke="#fff" stroke-width="3"/><rect x="${96 + i * 118}" y="325" width="16" height="4" fill="#555"/>`).join('')}
        <rect x="30" y="288" width="740" height="16" fill="#cfc6b8"/><rect x="40" y="90" width="720" height="120" fill="#fff"/>${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="${50 + i * 118}" y="100" width="108" height="100" fill="${p.wall}" stroke="${p.fabric}" stroke-width="3"/>`).join('')}
        <rect x="300" y="250" width="200" height="38" fill="#3a3a3a"/>${[330, 380, 430, 470].map((x) => `<circle cx="${x}" cy="269" r="12" fill="#555"/>`).join('')}
        <rect x="560" y="255" width="120" height="33" fill="#c8ced3"/><path d="M620 255 V230 Q620 222 630 222 H645" stroke="#999" stroke-width="5" fill="none"/>
        <rect x="250" y="470" width="300" height="20" fill="#5a3b2e"/><rect x="270" y="490" width="12" height="90" fill="#5a3b2e"/><rect x="518" y="490" width="12" height="90" fill="#5a3b2e"/>`,
      );
    case 'bedroom':
    case 'bedroom2': {
      const kids = r === 'bedroom2';
      return room(
        p,
        `${win(560, 110, 180, 200, p.sky)}<rect x="${kids ? 90 : 120}" y="${kids ? 340 : 300}" width="${kids ? 260 : 380}" height="${kids ? 110 : 150}" rx="12" fill="#fff"/>
        <rect x="${kids ? 90 : 120}" y="${kids ? 380 : 350}" width="${kids ? 260 : 380}" height="${kids ? 70 : 100}" rx="10" fill="${kids ? p.fabric : p.accent}" opacity=".85"/>
        <rect x="${kids ? 80 : 105}" y="${kids ? 260 : 210}" width="24" height="${kids ? 190 : 240}" fill="#5a3b2e"/>
        <rect x="${kids ? 110 : 150}" y="${kids ? 345 : 310}" width="70" height="36" rx="10" fill="${p.wall}"/>${kids ? '' : `<rect x="400" y="310" width="70" height="36" rx="10" fill="${p.wall}"/>`}
        <rect x="${kids ? 380 : 530}" y="380" width="70" height="60" fill="#8a5a3c"/><circle cx="${kids ? 415 : 565}" cy="360" r="16" fill="#f6d77a"/>
        ${kids ? `<rect x="420" y="160" width="100" height="100" fill="${p.accent}" opacity=".3"/><circle cx="470" cy="210" r="30" fill="#fff" opacity=".8"/><rect x="600" y="400" width="120" height="40" rx="8" fill="${p.accent}"/>` : `<rect x="210" y="120" width="200" height="70" fill="#fff" stroke="${p.accent}" stroke-width="6"/>`}`,
      );
    }
    case 'bathroom':
      return `<rect width="800" height="600" fill="#e8eef0"/>` +
        Array.from({ length: 8 }, (_, i) => `<line x1="${i * 100}" y1="0" x2="${i * 100}" y2="600" stroke="#cfd8dc" stroke-width="3"/><line x1="0" y1="${i * 80}" x2="800" y2="${i * 80}" stroke="#cfd8dc" stroke-width="3"/>`).join('') +
        `<rect x="60" y="330" width="380" height="150" rx="40" fill="#fff" stroke="#c5ced2" stroke-width="4"/><rect x="80" y="345" width="340" height="60" rx="26" fill="${p.sky}"/>
        <path d="M400 330 V230 Q400 210 380 210" stroke="#9aa5ab" stroke-width="8" fill="none"/><rect x="520" y="300" width="200" height="40" rx="8" fill="#fff" stroke="#c5ced2" stroke-width="3"/>
        <rect x="560" y="340" width="120" height="140" fill="${p.accent}" opacity=".7"/><rect x="540" y="110" width="160" height="170" rx="10" fill="#dfe8ec" stroke="#9aa5ab" stroke-width="6"/>
        <rect x="0" y="480" width="800" height="120" fill="#b9c6cc"/>${plant(740, 260)}`;
    case 'hallway':
      return room(
        p,
        `<rect x="300" y="90" width="200" height="350" fill="#6b4a32"/><rect x="320" y="110" width="160" height="310" fill="#7c573c"/><circle cx="470" cy="270" r="8" fill="#e8c26a"/>
        <rect x="80" y="160" width="140" height="220" rx="70" fill="#dfe8ec" stroke="${p.accent}" stroke-width="6"/><rect x="560" y="140" width="10" height="160" fill="#5a3b2e"/>
        ${[600, 640, 680].map((x, i) => `<circle cx="${x}" cy="${160 + i * 4}" r="8" fill="#5a3b2e"/><rect x="${x - 18}" y="${170 + i * 4}" width="36" height="${90 - i * 10}" rx="6" fill="${i % 2 ? p.fabric : p.accent}"/>`).join('')}
        <rect x="560" y="380" width="200" height="60" fill="${p.fabric}"/><rect x="250" y="470" width="300" height="80" rx="10" fill="${p.accent}" opacity=".5"/>`,
      );
    case 'balcony':
    case 'terrace':
      return `<rect width="800" height="600" fill="${p.sky}"/><circle cx="640" cy="120" r="50" fill="#fff" opacity=".85"/>
        <path d="M0 330 L120 220 L240 300 L360 180 L470 290 L600 200 L800 320 V420 H0Z" fill="#9fb5c9"/><path d="M0 380 L200 300 L420 360 L620 290 L800 360 V420 H0Z" fill="#8aa2b8"/>
        <rect y="420" width="800" height="180" fill="${r === 'terrace' ? '#c49a6c' : '#bfb6aa'}"/><rect y="400" width="800" height="12" fill="#5a5a5a"/>
        ${Array.from({ length: 17 }, (_, i) => `<rect x="${i * 50}" y="300" width="6" height="110" fill="#5a5a5a"/>`).join('')}<rect y="296" width="800" height="10" fill="#5a5a5a"/>
        <rect x="140" y="470" width="160" height="12" fill="#8a5a3c"/><rect x="150" y="482" width="8" height="60" fill="#8a5a3c"/><rect x="282" y="482" width="8" height="60" fill="#8a5a3c"/>
        <rect x="360" y="450" width="90" height="70" rx="12" fill="${p.fabric}"/>${plant(620, 470)}`;
    case 'garage':
      return `<rect width="800" height="600" fill="${p.sky}"/><rect y="480" width="800" height="120" fill="#a9a39a"/><rect x="150" y="200" width="500" height="280" fill="${p.wall}" stroke="${p.accent}" stroke-width="4"/>
        <polygon points="130,210 400,120 670,210" fill="${p.accent}"/><rect x="220" y="260" width="360" height="220" fill="#d7dade"/>${Array.from({ length: 7 }, (_, i) => `<line x1="220" y1="${290 + i * 28}" x2="580" y2="${290 + i * 28}" stroke="#aeb3b8" stroke-width="4"/>`).join('')}`;
    case 'view':
      return `<rect width="800" height="600" fill="#e9eef2"/><rect x="60" y="50" width="680" height="440" fill="${p.sky}"/>
        <path d="M60 330 L250 120 L330 200 L440 90 L560 230 L740 160 V490 H60Z" fill="#f4f6f8"/><path d="M60 330 L250 160 L330 240 L440 140 L560 270 L740 210 V490 H60Z" fill="#aab9c8"/>
        <path d="M60 420 H740 V490 H60Z" fill="#c9b79a"/>${Array.from({ length: 12 }, (_, i) => `<rect x="${80 + i * 55}" y="${380 - (i % 4) * 18}" width="40" height="${110 + (i % 4) * 18}" fill="${i % 2 ? p.accent : p.fabric}" opacity=".7"/>`).join('')}
        <rect x="60" y="50" width="680" height="440" fill="none" stroke="#fff" stroke-width="18"/><line x1="400" y1="50" x2="400" y2="490" stroke="#fff" stroke-width="12"/><rect x="40" y="490" width="720" height="24" fill="#fff"/>`;
    case 'plan': {
      const grid = kind === 'house' ? [[60, 60, 340, 250], [400, 60, 340, 160], [400, 220, 340, 90], [60, 310, 220, 230], [280, 310, 220, 230], [500, 310, 240, 230]] : [[60, 60, 380, 260], [440, 60, 300, 260], [60, 320, 240, 220], [300, 320, 200, 220], [500, 320, 240, 220]];
      const names = kind === 'house' ? ['Гостиная', 'Кухня', 'Санузел', 'Спальня', 'Спальня', 'Терраса'] : ['Гостиная', 'Спальня', 'Кухня', 'Санузел', 'Детская'];
      return `<rect width="800" height="600" fill="#fbfaf7"/>` +
        grid.map(([x, y, w, h], i) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${i % 2 ? '#f1ece2' : '#fff'}" stroke="#2c2c2c" stroke-width="8"/><text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" font-family="Arial" font-size="22" fill="#555">${names[i]}</text><text x="${x + w / 2}" y="${y + h / 2 + 26}" text-anchor="middle" font-family="Arial" font-size="15" fill="#999">${Math.round((w * h) / 2600)} м²</text>`).join('') +
        `<rect x="${kind === 'house' ? 180 : 200}" y="536" width="70" height="12" fill="#fbfaf7"/>`;
    }
  }
}

export function demoPhoto(kind: 'house' | 'apartment', seed: number, index: number, label: string) {
  const rooms = kind === 'house' ? HOUSE_ROOMS : APARTMENT_ROOMS;
  const r = rooms[index % rooms.length] as Room;
  const p = PALETTES[seed % PALETTES.length];
  const text = `${ROOM_LABEL[r]} · ${label}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">${scene(r, kind, p, seed)}
    <rect x="18" y="544" rx="8" width="${Math.min(764, text.length * 10.5 + 30)}" height="40" fill="#000" opacity=".5"/>
    <text x="34" y="571" font-family="Arial, sans-serif" font-size="19" fill="#fff">${text}</text></svg>`;
}

/** Минимальный PDF-документ с несколькими строками текста (латиница). */
export function demoPdf(text: string | string[]) {
  const lines = (Array.isArray(text) ? text : [text]).map((l) => l.replace(/[()\\]/g, ''));
  const content = lines.map((l, i) => `BT /F1 ${i === 0 ? 18 : 12} Tf 60 ${780 - i * 26} Td (${l}) Tj ET`).join('\n');
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
