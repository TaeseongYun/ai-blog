// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig, fontProviders } from 'astro/config';

// https://astro.build/config
// TaeseongYun/ai-blog → GitHub Pages 프로젝트 사이트
const base = '/ai-blog';

export default defineConfig({
	site: 'https://taeseongyun.github.io',
	base,
	// 홈이 곧 글 목록이므로 기존 /blog 목록 주소는 홈으로 보낸다
	// (redirect 목적지에는 Astro가 base를 붙여주지 않아 직접 포함)
	redirects: { '/blog': `${base}/` },
	integrations: [mdx(), sitemap()],
	fonts: [
		{
			provider: fontProviders.local(),
			name: 'Atkinson',
			cssVariable: '--font-atkinson',
			fallbacks: ['sans-serif'],
			options: {
				variants: [
					{
						src: ['./src/assets/fonts/atkinson-regular.woff'],
						weight: 400,
						style: 'normal',
						display: 'swap',
					},
					{
						src: ['./src/assets/fonts/atkinson-bold.woff'],
						weight: 700,
						style: 'normal',
						display: 'swap',
					},
				],
			},
		},
	],
});
