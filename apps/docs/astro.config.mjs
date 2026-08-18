// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://brevi.dev',
	integrations: [
		starlight({
			title: 'brevi',
			description:
				'A local sandbox and orchestrator for coding agents. Tag a Linear ticket, get a pull request with a demo.',
			logo: { src: './src/assets/logo.png', alt: 'brevi' },
			favicon: '/favicon.ico',
			components: {
				// Adds PostHog to every page; see src/components/Head.astro.
				Head: './src/components/Head.astro',
			},
			head: [
				{
					tag: 'link',
					attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
				},
			],
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/adapter/brevi' }],
			sidebar: [
				{ label: 'Download', slug: 'download' },
				{ label: 'Getting started', slug: 'getting-started' },
				{
					label: 'Guides',
					items: [
						{ label: 'Connections', slug: 'guides/connections' },
						{ label: 'Tickets and runs', slug: 'guides/tickets' },
						{ label: 'Sandboxes', slug: 'guides/sandboxes' },
						{ label: 'Workers', slug: 'guides/workers' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Configuration', slug: 'reference/configuration' },
						{ label: 'API', slug: 'reference/api' },
						{ label: 'Changelog', slug: 'reference/changelog' },
					],
				},
			],
		}),
	],
});
