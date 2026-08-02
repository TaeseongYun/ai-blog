# AI 활용 개발일지 블로그

내 Claude Code 대화 로그(`~/.claude/projects/**/*.jsonl`)를 로컬 LLM으로 요약해
"내가 이번에 AI에게 뭘 물어봤고 어떻게 썼는지" 블로그 초안을 반자동으로 만든다.

```
Claude Code 로그 → 로컬 LLM(Ollama) → 마크다운 초안 → 내가 검토·수정 → git push(=발행)
```

## 구성

- **로컬 LLM**: Ollama + `qwen2.5:14b` (한국어+코딩 균형, M1 Max 32GB 기준)
- **블로그**: Astro `blog` 템플릿 (정적 사이트) → GitHub Pages 자동 배포
- **파이프라인**: `tools/draft.mjs`

## 한 번만: 설치 확인

```bash
ollama list            # qwen2.5:14b 보이면 OK. 없으면 ↓
ollama pull qwen2.5:14b
brew services start ollama   # 데몬 상시 실행(재부팅 후 자동)
```

## 매번: 초안 만들고 발행

```bash
cd ~/work/ai-blog

# 1) 최근 7일 로그로 초안 생성 (모델은 --model 로 교체 가능)
node tools/draft.mjs                 # 최근 7일
node tools/draft.mjs --days 14       # 기간 조절

# 2) 로컬에서 확인
npm run dev                          # http://localhost:4321

# 3) src/content/blog/ai-log-YYYY-MM-DD.md 를 직접 다듬는다
#    (LLM 초안은 초안일 뿐. 팩트/톤 손보고 민감정보 확인)

# 4) 발행
git add . && git commit -m "post: AI 활용 기록" && git push
```

## GitHub Pages 배포 (최초 1회)

1. GitHub에 리포 생성 후 push
2. `astro.config.mjs`의 `site`(필요시 `base`) 를 본인 값으로 수정
3. 리포 **Settings → Pages → Source: GitHub Actions** 선택
4. 이후 `main`에 push 하면 `.github/workflows/deploy.yml`이 자동 빌드·배포

## 커스터마이즈

- 사이트 제목/설명: `src/consts.ts`
- 초안 프롬프트·필터: `tools/draft.mjs` (system/user 프롬프트, NOISE 정규식)
- 모델 교체: `node tools/draft.mjs --model llama3.1:8b`

## 주의

- LLM 초안은 **반드시 검토**하고 발행. 로그에 회사/실제 코드가 섞였을 수 있으니
  공개 전 민감정보를 직접 확인한다. (프롬프트에 일반화 지시가 있지만 100% 보장 아님)
