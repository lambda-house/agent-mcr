import { createPlugin } from '../sdk';
import themeCss from './theme.css?inline';

export const plugin = createPlugin({
  id: 'theme-overrides',
  name: 'Theme Overrides',
  version: '1.0.0',
  description: 'Custom CSS tokens and visual overrides layered on top of core styles.',
  setup() {
    let styleEl: HTMLStyleElement | null = null;
    if (typeof document !== 'undefined' && themeCss.trim()) {
      styleEl = document.createElement('style');
      styleEl.dataset.plugin = 'theme-overrides';
      styleEl.textContent = themeCss;
      document.head.appendChild(styleEl);
    }
    return () => {
      styleEl?.remove();
      styleEl = null;
    };
  },
});
