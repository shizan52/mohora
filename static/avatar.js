// Two drawn interviewers whose faces follow the interview: they blink, breathe, look up
// while thinking, nod while you talk, raise their brows on a follow-up and move their
// lips with the actual audio level of their voice.

const NS = 'http://www.w3.org/2000/svg';

export const PEOPLE = {
  ayesha: {
    id: 'ayesha', name: 'Ayesha Rahman', gender: 'female',
    skin: '#c98b62', shade: '#a86c47', neck: '#b57650', hair: '#231a17', iris: '#4a2e1e',
    lips: '#a84f4f', inside: '#5a1f22', jacket: '#2d3a7a', jacketDark: '#212c61', shirt: '#f4f1ec', blush: '#e0745f',
  },
  tanvir: {
    id: 'tanvir', name: 'Tanvir Ahmed', gender: 'male',
    skin: '#b57a51', shade: '#94603c', neck: '#a26a44', hair: '#17130f', iris: '#3a2416',
    lips: '#8e4a3e', inside: '#4f1d1a', jacket: '#3a3f4b', jacketDark: '#2b2f39', shirt: '#dce7f7', blush: '#d46b52',
  },
};

export const personFor = (id) => PEOPLE[id] || PEOPLE.ayesha;

const MOOD_SMILE = { friendly: 0.38, neutral: 0.2, skeptical: 0.04 };

function hairFor(p) {
  if (p.id === 'ayesha') {
    return {
      back: 'M112 152 C96 110 100 56 160 50 C220 56 224 110 208 152 C214 174 200 188 188 182 C196 160 200 130 196 106 L124 106 C120 130 124 160 132 182 C120 188 106 174 112 152 Z',
      front: 'M114 102 C110 62 136 47 166 49 C197 51 211 73 206 102 C199 82 186 69 167 65 C149 77 130 86 114 102 Z',
    };
  }
  return {
    back: 'M113 102 C108 50 212 50 207 102 Z',
    front: 'M114 97 C110 58 138 43 164 45 C195 47 211 66 206 97 C202 80 192 69 176 67 C160 74 138 70 122 80 C118 84 115 90 114 97 Z',
  };
}

function build(p) {
  const hair = hairFor(p);
  const male = p.id === 'tanvir';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 320 240');
  // Fill any frame like a video feed: crop the edges of the room, never the face.
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  svg.setAttribute('class', 'avatar');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${p.name}, your interviewer`);
  svg.innerHTML = `
    <rect width="320" height="240" fill="#222c62"/>
    <rect x="218" y="22" width="84" height="112" rx="4" fill="#33437f"/>
    <path d="M260 22 V134 M218 78 H302" stroke="#28356c" stroke-width="4"/>
    <rect x="14" y="74" width="82" height="4" rx="2" fill="#2d387a"/>
    <rect x="20" y="50" width="9" height="24" rx="1.5" fill="#3a4a8c"/><rect x="31" y="55" width="8" height="19" rx="1.5" fill="#46407f"/>
    <rect x="41" y="47" width="10" height="27" rx="1.5" fill="#2f5a73"/><rect x="62" y="58" width="16" height="16" rx="3" fill="#34417e"/>
    <ellipse cx="44" cy="166" rx="15" ry="24" fill="#2b5b55" transform="rotate(-18 44 166)"/>
    <ellipse cx="58" cy="160" rx="13" ry="26" fill="#336b60" transform="rotate(14 58 160)"/>
    <rect x="30" y="182" width="38" height="34" rx="5" fill="#2d3770"/>
    <g data-part="body">
      <path d="M68 240 C72 206 104 190 140 184 L180 184 C216 190 248 206 252 240 Z" fill="${p.jacket}"/>
      <path d="M140 184 L160 222 L180 184 Z" fill="${p.shirt}"/>
      ${male ? `<path d="M141 183 L155 203 L160 190 Z M179 183 L165 203 L160 190 Z" fill="#eef3fb"/>` : ''}
      <path d="M140 184 L160 222 L149 236 L127 196 Z" fill="${p.jacketDark}"/>
      <path d="M180 184 L160 222 L171 236 L193 196 Z" fill="${p.jacketDark}"/>
    </g>
    <g data-part="head">
      ${hair.back ? `<path d="${hair.back}" fill="${p.hair}"/>` : ''}
      <path d="M144 150 L144 188 Q160 197 176 188 L176 150 Z" fill="${p.neck}"/>
      <ellipse cx="113" cy="108" rx="7" ry="11" fill="${p.shade}"/>
      <ellipse cx="207" cy="108" rx="7" ry="11" fill="${p.shade}"/>
      <path d="M114 102 C114 58 206 58 206 102 C206 142 190 170 160 172 C130 170 114 142 114 102 Z" fill="${p.skin}"/>
      ${male ? `<path d="M118 124 C122 157 142 171 160 171 C178 171 198 157 202 124 C196 147 180 161 160 161 C140 161 124 147 118 124 Z" fill="${p.hair}" opacity=".28"/>` : ''}
      <ellipse cx="138" cy="130" rx="8" ry="4.5" fill="${p.blush}" opacity=".2"/>
      <ellipse cx="182" cy="130" rx="8" ry="4.5" fill="${p.blush}" opacity=".2"/>
      ${['l', 'r'].map((side) => {
        const cx = side === 'l' ? 142 : 178;
        return `<g data-eye="${side}">
          <ellipse cx="${cx}" cy="108" rx="8.6" ry="6" fill="#fbf8f4"/>
          <g data-iris="${side}"><circle cx="${cx}" cy="108" r="4.7" fill="${p.iris}"/><circle cx="${cx}" cy="108" r="2.2" fill="#120c0a"/><circle cx="${cx + 1.6}" cy="106.3" r="1.2" fill="#fff"/></g>
          <path d="M${cx - 10} 106 Q${cx} 98.5 ${cx + 10} 106" stroke="${p.hair}" stroke-width="2.1" fill="none" stroke-linecap="round"/>
        </g>`;
      }).join('')}
      <path data-brow="l" d="M130 94 Q142 87 154 92" stroke="${p.hair}" stroke-width="3.4" fill="none" stroke-linecap="round"/>
      <path data-brow="r" d="M166 92 Q178 87 190 94" stroke="${p.hair}" stroke-width="3.4" fill="none" stroke-linecap="round"/>
      <path d="M160 112 Q156 126 152 129 Q160 133 168 129" stroke="${p.shade}" stroke-width="1.9" fill="none" stroke-linecap="round"/>
      ${male ? `<path d="M145 138 Q160 131 175 138 Q160 135 145 138 Z" fill="${p.hair}" opacity=".55"/>` : ''}
      <path data-mouth d="" fill="${p.inside}" stroke="${p.lips}" stroke-width="2.2" stroke-linejoin="round"/>
      <path data-teeth d="" fill="#f7f3ee"/>
      <path d="${hair.front}" fill="${p.hair}"/>
      ${male ? `<g stroke="#1d2029" stroke-width="2.2" fill="rgba(255,255,255,.07)">
          <rect x="128.5" y="98.5" width="27" height="19" rx="7"/><rect x="164.5" y="98.5" width="27" height="19" rx="7"/>
          <path d="M155.5 106 Q160 103 164.5 106 M128.5 105 L116 103 M191.5 105 L204 103" fill="none"/></g>`
        : `<circle cx="112" cy="122" r="2.6" fill="#d8b25a"/><circle cx="208" cy="122" r="2.6" fill="#d8b25a"/>`}
    </g>`;
  return svg;
}

const lerp = (a, b, k) => a + (b - a) * k;

export class Avatar {
  constructor(host, personId = 'ayesha', { mood = 'neutral', still = false } = {}) {
    this.person = personFor(personId);
    this.svg = build(this.person);
    host.replaceChildren(this.svg);
    this.parts = {
      head: this.svg.querySelector('[data-part="head"]'),
      body: this.svg.querySelector('[data-part="body"]'),
      eyes: [...this.svg.querySelectorAll('[data-eye]')],
      irises: [...this.svg.querySelectorAll('[data-iris]')],
      brows: [...this.svg.querySelectorAll('[data-brow]')],
      mouth: this.svg.querySelector('[data-mouth]'),
      teeth: this.svg.querySelector('[data-teeth]'),
    };
    this.mood = mood;
    this.state = 'idle';
    this.level = 0;
    this.heard = 0;
    this.reaction = null;
    this.still = still || matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.cur = { smile: MOOD_SMILE[mood] ?? 0.2, open: 0, raise: 0, knit: 0, gx: 0, gy: 0, tilt: 0 };
    this.blinkAt = performance.now() + 1500;
    this.blink = 0;
    this.nod = { start: 0 };
    this.lastNod = 0;
    this.heardSince = 0;
    this.visible = true;
    this.last = performance.now();
    if ('IntersectionObserver' in window) {
      this.observer = new IntersectionObserver(([entry]) => (this.visible = entry.isIntersecting));
      this.observer.observe(this.svg);
    }
    this.frame = this.frame.bind(this);
    this.raf = requestAnimationFrame(this.frame);
  }

  setState(state) {
    this.state = state;
    if (state !== 'speaking') this.level = 0;
  }

  setMood(mood) {
    this.mood = mood;
  }

  // One-off expressions: 'smile', 'nod', 'curious', 'concern'.
  react(kind, ms = 2200) {
    if (kind === 'nod') this.nod.start = performance.now();
    else this.reaction = { kind, until: performance.now() + ms };
  }

  setLevel(v) {
    this.level = Math.max(0, Math.min(1, v));
  }

  setHeard(v) {
    this.heard = v;
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.observer?.disconnect();
  }

  targets(now) {
    const t = now / 1000;
    const base = MOOD_SMILE[this.mood] ?? 0.2;
    const target = { smile: base, open: 0, raise: 0, knit: 0, gx: 0, gy: 0, tilt: 0 };
    if (this.state === 'idle' && !this.still) {
      target.gx = Math.sin(t * 0.37) * 0.35;
      target.gy = Math.sin(t * 0.23) * 0.2;
    }
    if (this.state === 'speaking') {
      target.open = this.level;
      target.raise = 0.12 + (this.still ? 0 : Math.max(0, Math.sin(t * 1.7)) * 0.18);
      target.smile = base * 0.8;
    }
    if (this.state === 'listening') {
      target.smile = base + 0.06;
      target.tilt = this.still ? 0 : 2.5;
      if (this.heard > 0.12) {
        this.heardSince ||= now;
        if (now - this.heardSince > 1600 && now - this.lastNod > 3400 + Math.random() * 1500) {
          this.lastNod = now;
          this.nod.start = now;
        }
      } else {
        this.heardSince = 0;
      }
    }
    if (this.state === 'thinking') {
      target.gx = -0.75;
      target.gy = -0.85;
      target.raise = 0.3;
      target.tilt = -4;
      target.smile = base * 0.4;
    }
    if (this.reaction && now < this.reaction.until) {
      const k = this.reaction.kind;
      if (k === 'smile') Object.assign(target, { smile: 1, open: Math.max(target.open, 0.2) });
      if (k === 'curious') Object.assign(target, { raise: 0.8, tilt: 4.5 });
      if (k === 'concern') Object.assign(target, { knit: 0.7, smile: 0 });
    }
    return target;
  }

  frame(now) {
    this.raf = requestAnimationFrame(this.frame);
    if (!this.visible) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const target = this.targets(now);
    const ease = 1 - Math.exp(-dt * 9);
    for (const key of Object.keys(this.cur)) {
      this.cur[key] = lerp(this.cur[key], target[key], key === 'open' ? 1 - Math.exp(-dt * 28) : ease);
    }

    if (now > this.blinkAt) {
      this.blink = Math.min(1, this.blink + dt * 14);
      if (this.blink >= 1) {
        this.blinkAt = now + (Math.random() < 0.15 ? 180 : 2400 + Math.random() * 3600);
        this.blink = 0.999;
      }
    } else {
      this.blink = Math.max(0, this.blink - dt * 11);
    }

    const nodT = (now - this.nod.start) / 900;
    const nod = nodT > 0 && nodT < 1 ? Math.sin(nodT * Math.PI * 2) ** 2 * 4.5 : 0;
    const breathe = this.still ? 0 : Math.sin(now / 1000 * 1.1) * 0.9;
    this.draw(breathe, nod);
  }

  draw(breathe, nod) {
    const c = this.cur;
    const p = this.parts;
    p.head.setAttribute('transform', `translate(0 ${(breathe * 0.6 + nod).toFixed(2)}) rotate(${c.tilt.toFixed(2)} 160 176)`);
    p.body.setAttribute('transform', `translate(0 ${(breathe * 0.35).toFixed(2)})`);
    const lid = 1 - Math.sin(this.blink * Math.PI) * 0.92;
    p.eyes.forEach((eye, i) => {
      const cx = i === 0 ? 142 : 178;
      eye.setAttribute('transform', `translate(${cx} 108) scale(1 ${lid.toFixed(3)}) translate(${-cx} -108)`);
    });
    p.irises.forEach((iris) => iris.setAttribute('transform', `translate(${(c.gx * 2.8).toFixed(2)} ${(c.gy * 2.1).toFixed(2)})`));
    p.brows.forEach((brow, i) => {
      const cx = i === 0 ? 142 : 178;
      const turn = (i === 0 ? 1 : -1) * c.knit * 9;
      brow.setAttribute('transform', `translate(0 ${(-c.raise * 4.5 + c.knit * 1.5).toFixed(2)}) rotate(${turn.toFixed(2)} ${cx} 91)`);
    });

    const cx = 160;
    const y = 144;
    const open = c.open;
    const w = 12.5 + c.smile * 3.5 - open * 1.5;
    const lift = c.smile * 3.8;
    const top = y - 2.2 - c.smile * 0.6 + open * 0.6;
    const bottom = y + 2.2 + open * 13 + c.smile * 2.4;
    p.mouth.setAttribute('d', `M${cx - w} ${y - lift} Q${cx} ${top - 1.6} ${cx + w} ${y - lift} Q${cx} ${bottom + 1.6} ${cx - w} ${y - lift} Z`);
    p.mouth.setAttribute('fill', open > 0.08 ? this.person.inside : this.person.lips);
    p.teeth.setAttribute('d', open > 0.16
      ? `M${cx - w * 0.68} ${top + 0.6} Q${cx} ${top + 3.2 + open * 2.4} ${cx + w * 0.68} ${top + 0.6} Z`
      : '');
  }
}
