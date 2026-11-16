import { createPlugin } from '../sdk';
import { MotionProvider, ToastProvider } from '@teob/ui';
import tokensCss from '@teob/ui/tokens.css?inline';
import bridgeCss from '@teob/ui/bridges/agent-mcr.css?inline';

export const plugin = createPlugin({
  id: 'teob-theme',
  name: 'TEOB UI Theme',
  version: '1.0.0',
  description: 'Surface Model design tokens, theme bridge, MotionProvider, and ToastProvider.',
  setup(api) {
    let styleEl: HTMLStyleElement | null = null;
    if (typeof document !== 'undefined') {
      styleEl = document.createElement('style');
      styleEl.dataset.plugin = 'teob-theme';
      styleEl.textContent = `${tokensCss}\n${bridgeCss}`;
      document.head.appendChild(styleEl);
      document.documentElement.dataset.teobTheme = 'on';
    }

    api.registerAppWrapper({
      id: 'teob-providers',
      order: 10,
      wrap: (children) => (
        <MotionProvider>
          <ToastProvider>{children}</ToastProvider>
        </MotionProvider>
      ),
    });

    return () => {
      styleEl?.remove();
      styleEl = null;
      if (typeof document !== 'undefined') {
        delete document.documentElement.dataset.teobTheme;
      }
    };
  },
});
