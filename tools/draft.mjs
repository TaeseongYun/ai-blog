#!/usr/bin/env node
// tools/draft.mjs
// Claude Code 대화 로그(~/.claude/projects/**/*.jsonl)를 읽어
// 로컬 LLM(Ollama)으로 "내 AI 활용 주간 기록" 블로그 초안(markdown)을 생성한다.
//
// 사용법:
//   node tools/draft.mjs                 # 최근 7일
//   node tools/draft.mjs --days 14       # 최근 14일
//   node tools/draft.mjs --model llama3.1:8b
//
// 전제: `ollama serve`가 떠 있고 --model 모델이 pull 되어 있을 것.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- args ---
const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const DAYS = Number(getArg('days', '7'));
const MODEL = getArg('model', 'qwen2.5:14b');
const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const PROJECTS = join(homedir(), '.claude', 'projects');
const OUT_DIR = join(__dirname, '..', 'src', 'content', 'blog');
const since = Date.now() - DAYS * 24 * 60 * 60 * 1000;

// 실제 질문이 아닌 노이즈(슬래시 명령, 훅 주입, 시스템 리마인더, 붙여넣은 XML 등) 걸러내기
const NOISE = [
  /^\s*</,                 // <command-...>, <system-reminder> 등 XML/태그로 시작
  /^\s*\//,                // /slash-command
  /system-reminder/i,
  /Caveat:/i,
  /local-command-stdout/i,
  /this session is being continued/i,
  /\[Request interrupted/i,
];
const isNoise = (t) => NOISE.some((r) => r.test(t));

// --- 1) 로그 수집 ---
function* jsonlFiles(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

const sessions = new Map(); // sessionId -> { title, branch, cwd, questions:[{t,text}] }
const ensure = (sid) => {
  if (!sessions.has(sid)) sessions.set(sid, { title: '', branch: '', cwd: '', questions: [] });
  return sessions.get(sid);
};

for (const f of jsonlFiles(PROJECTS)) {
  let lines;
  try { lines = readFileSync(f, 'utf8').trim().split('\n'); } catch { continue; }
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const sid = o.sessionId || f;
    if (o.type === 'ai-title' && o.title) ensure(sid).title = o.title;
    if (o.type === 'user' && !o.isMeta && typeof o.message?.content === 'string') {
      const text = o.message.content.trim();
      if (!text || isNoise(text)) continue;
      const t = Date.parse(o.timestamp || '') || 0;
      if (t && t < since) continue;
      const s = ensure(sid);
      s.branch ||= o.gitBranch || '';
      s.cwd ||= o.cwd || '';
      s.questions.push({ t, text: text.replace(/\s+/g, ' ').slice(0, 600) });
    }
  }
}

const active = [...sessions.values()]
  .filter((s) => s.questions.length)
  .sort((a, b) => (b.questions.at(-1).t || 0) - (a.questions.at(-1).t || 0));

if (!active.length) {
  console.error(`최근 ${DAYS}일 내 사용자 질문을 찾지 못했습니다. --days 를 늘려보세요.`);
  process.exit(1);
}

const digest = active.slice(0, 20).map((s, i) => {
  const proj = (s.cwd || '').split('/').filter(Boolean).pop() || 'unknown';
  const qs = s.questions.slice(0, 8).map((q) => `- ${q.text}`).join('\n');
  return `### 세션 ${i + 1}: ${s.title || proj} (프로젝트: ${proj}${s.branch ? `, 브랜치 ${s.branch}` : ''})\n${qs}`;
}).join('\n\n');

const qCount = active.reduce((n, s) => n + s.questions.length, 0);
console.log(`수집: 세션 ${active.length}개 / 질문 ${qCount}개 (최근 ${DAYS}일) → ${MODEL} 로 초안 생성...`);

// --- 2) 로컬 LLM 호출 ---
const system =
  '너는 개발자의 AI 활용 기록을 정리해 담백한 한국어 테크 블로그 글로 만드는 작가다. ' +
  '과장·이모지 남발·불릿 남발을 피하고, 솔직하고 읽기 쉬운 산문으로 쓴다. 코드블록은 꼭 필요할 때만.';

const user = `아래는 내가 지난 ${DAYS}일간 AI 코딩 도구(Claude Code 등)에게 실제로 물어본 질문들이야.
이걸 바탕으로 블로그 글 초안을 마크다운으로 써줘.

구성:
1. 이번 기간에 AI를 주로 어디에 썼는지 (주제별로 묶어서)
2. 인상적이었던 활용 1~2개를 구체적으로
3. 여기서 느낀 요즘 개발 생태계 흐름 (AI 페어코딩, 로컬 LLM, 코딩 에이전트 등)
4. 다음에 시도해볼 것

규칙:
- 제목은 "# " 한 줄로 시작
- 첫 문단은 한두 문장 요약
- 회사명/실제 코드/파일경로 같은 민감정보는 일반화해서 언급 (그대로 노출 금지)

--- 질문 모음 ---
${digest}`;

let body;
try {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      options: { temperature: 0.7 },
    }),
  });
  if (!res.ok) {
    console.error(`Ollama 오류 ${res.status}: ${await res.text()}`);
    console.error('→ `ollama serve` 실행 여부와 `ollama list` 에 모델이 있는지 확인하세요.');
    process.exit(1);
  }
  body = (await res.json()).message?.content?.trim() || '';
} catch (e) {
  console.error(`Ollama 연결 실패: ${e.message}`);
  console.error('→ `brew services start ollama` 로 데몬을 먼저 띄우세요.');
  process.exit(1);
}

if (!body) { console.error('LLM 응답이 비었습니다.'); process.exit(1); }

// --- 3) markdown 파일로 저장 (Astro blog 스키마: title/description/pubDate) ---
const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const titleMatch = body.match(/^#\s+(.+)$/m);
const title = (titleMatch?.[1] || `AI 활용 기록 (${today})`).trim();
body = body.replace(/^#\s+.+$\r?\n?/m, '').trim(); // 본문 중복 h1 제거 (레이아웃이 제목 렌더)
const description =
  (body.split('\n').find((l) => l.trim() && !l.startsWith('#')) || 'AI 활용 주간 기록')
    .replace(/[#*`>]/g, '').trim().slice(0, 150);

const fm = `---
title: ${JSON.stringify(title)}
description: ${JSON.stringify(description)}
pubDate: ${today}
---

`;

mkdirSync(OUT_DIR, { recursive: true });
const out = join(OUT_DIR, `ai-log-${today}.md`);
writeFileSync(out, fm + body + '\n');

console.log(`\n✅ 초안 생성 완료: ${out}`);
console.log(`   제목: ${title}`);
console.log(`   미리보기: npm run dev  →  http://localhost:4321/blog/ai-log-${today}/`);
console.log(`   발행: 내용 검토·수정 후  git add . && git commit && git push`);
