#!/usr/bin/env node
// tools/curate.mjs
// 평일 개발글 큐레이션: 한국 공휴일이면 종료, 아니면 Hacker News + GeekNews 인기글을
// Google Gemini(무료티어)로 요약·선정해 블로그 포스트 초안(markdown)을 만든다.
// GitHub Actions cron에서 실행 → 초안 파일 생성 → 워크플로우가 PR로 올림(=승인 후 발행).
//
// 사용법:
//   GEMINI_API_KEY=... node tools/curate.mjs          # 실제 생성
//   node tools/curate.mjs --dry                        # 수집만(제미나이 호출 X)
//   node tools/curate.mjs --selftest                   # 로직 자체검증(네트워크/키 불필요)
//   node tools/curate.mjs --force                      # 공휴일이어도 진행(테스트용)

import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Holidays from 'date-holidays';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'src', 'content', 'blog');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

// --- 피드 파서: RSS(<item>/<link>text) + Atom(<entry>/<link href>) 둘 다 (XML 파서 dep 불필요) ---
function parseRss(xml) {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)].map((m) => m[0]);
  return blocks.map((b) => {
    const t = b.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    // Atom: <link href="..."/>  |  RSS: <link>...</link>
    const l = b.match(/<link[^>]*href=["']([^"']+)["']/) || b.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/);
    return { title: t?.[1]?.trim(), link: l?.[1]?.trim() };
  }).filter((x) => x.title && x.link);
}

// --- 한국 공휴일 판정 (date-holidays는 tz 인지: 넘긴 시각을 KR 로컬로 변환) ---
function isKrPublicHoliday(date) {
  const res = new Holidays('KR').isHoliday(date);
  return Array.isArray(res) && res.some((h) => h.type === 'public');
}

// --- 자체검증 ---
function selftest() {
  const rss = `<rss><channel>
    <item><title><![CDATA[테스트 글]]></title><link>https://ex.com/a</link></item>
    <item><title>Plain 글</title><link>https://ex.com/b</link></item>
  </channel></rss>`;
  const rssItems = parseRss(rss);
  console.assert(rssItems.length === 2, 'RSS 2건 파싱 실패');
  console.assert(rssItems[0].title === '테스트 글' && rssItems[0].link === 'https://ex.com/a', 'RSS CDATA 파싱 실패');
  const atom = `<feed><entry><title>아톰 글</title><link href="https://ex.com/c" /></entry></feed>`;
  const atomItems = parseRss(atom);
  console.assert(atomItems.length === 1 && atomItems[0].link === 'https://ex.com/c', 'Atom 파싱 실패');
  // 광복절(8/15)은 공휴일, 8/12는 아님 (KR 정오로 판정)
  console.assert(isKrPublicHoliday(new Date('2026-08-15T03:00:00Z')) === true, '광복절 미탐지');
  console.assert(isKrPublicHoliday(new Date('2026-08-12T03:00:00Z')) === false, '평일 오탐');
  console.log('✅ selftest 통과');
}

async function fetchHN() {
  const r = await fetch('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30');
  const d = await r.json();
  return (d.hits || [])
    .filter((h) => h.url && h.title)
    .sort((a, b) => (b.points || 0) - (a.points || 0))
    .slice(0, 15)
    .map((h) => ({ title: h.title, link: h.url, points: h.points, src: 'HN' }));
}

async function fetchGeekNews() {
  const r = await fetch('https://news.hada.io/rss/news', { headers: { 'user-agent': 'Mozilla/5.0 (ai-blog curator)' } });
  return parseRss(await r.text()).slice(0, 15).map((x) => ({ ...x, src: 'GeekNews' }));
}

async function gemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { console.error('GEMINI_API_KEY 없음'); process.exit(1); }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!r.ok) { console.error(`Gemini 오류 ${r.status}: ${await r.text()}`); process.exit(1); }
  const d = await r.json();
  const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) { console.error('Gemini 응답 비어있음:', JSON.stringify(d).slice(0, 500)); process.exit(1); }
  return text.trim();
}

async function main() {
  if (has('--selftest')) { selftest(); return; }

  if (!has('--force') && isKrPublicHoliday(new Date())) {
    console.log('오늘은 한국 공휴일 — 포스트 생성 건너뜀.');
    return; // 파일 미생성 → 워크플로우가 PR 안 만듦
  }

  const [hn, gn] = await Promise.all([fetchHN(), fetchGeekNews()]);
  const items = [...hn, ...gn];
  if (!items.length) { console.error('수집된 글이 없습니다.'); process.exit(1); }

  const list = items.map((it, i) =>
    `${i + 1}. [${it.src}] ${it.title}${it.points ? ` (${it.points}pt)` : ''}\n   ${it.link}`
  ).join('\n');
  console.log(`수집: HN ${hn.length} + GeekNews ${gn.length} = ${items.length}건`);

  if (has('--dry')) { console.log(list); return; }

  const prompt = `너는 한국 개발자를 위한 테크 블로그 작가야.
아래는 오늘 Hacker News와 GeekNews에서 화제가 된 개발 관련 글 목록이야.
이 중에서 "한국 개발자들이 가장 흥미로워할 글" 딱 하나를 골라, 그 글을 소개하는 블로그 포스트를 한국어 마크다운으로 써줘.

구성:
- 첫 줄은 "# 제목" (클릭하고 싶은 제목)
- 다음 한두 문장으로 무슨 글인지 요약
- 왜 흥미로운지 / 어떤 맥락인지
- 요즘 개발 생태계 관점에서의 의미
- 마지막에 "원문: <링크>" 로 출처를 반드시 명시

규칙: 원문을 그대로 베끼지 말고 네 언어로 소개·해설할 것. 담백하게, 이모지·불릿 남발 금지.

--- 오늘의 글 목록 ---
${list}`;

  let body = await gemini(prompt);

  // Astro blog 스키마(title/description/pubDate)에 맞춰 저장
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }))
    .toISOString().slice(0, 10);
  const titleMatch = body.match(/^#\s+(.+)$/m);
  const title = (titleMatch?.[1] || `오늘의 개발글 (${today})`).trim();
  body = body.replace(/^#\s+.+$\r?\n?/m, '').trim();
  const description = (body.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '오늘의 개발글 큐레이션')
    .replace(/[#*`>]/g, '').trim().slice(0, 150);

  const fm = `---
title: ${JSON.stringify(title)}
description: ${JSON.stringify(description)}
pubDate: ${today}
---

`;
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, `curated-${today}.md`);
  writeFileSync(out, fm + body + '\n');
  console.log(`✅ 초안 생성: ${out}\n   제목: ${title}`);

  // GitHub Actions로 제목/생성여부 전달 (PR 제목·생성조건용)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `created=true\ntitle=${title.replace(/\n/g, ' ')}\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
