import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { useStore } from './store';
// Fonts are bundled, not fetched: the app must work offline
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@lambda-house/tokens/tokens.css';
import '@lambda-house/ui/ui.css';
import './styles/index.css';
import { pluginRegistry, usePluginVersion } from './plugins';

// Apply the persisted theme before the first paint (no dark flash in light
// mode), and follow later changes
const applyTheme = (theme: string) => {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle('dark', theme === 'dark');
};
applyTheme(useStore.getState().theme);
useStore.subscribe((state, prev) => {
  if (state.theme !== prev.theme) applyTheme(state.theme);
});

function PluginAppRoot() {
  usePluginVersion();
  const wrappers = pluginRegistry.getAppWrappers();
  let node: React.ReactNode = <App />;
  for (let i = wrappers.length - 1; i >= 0; i--) {
    node = wrappers[i].wrap(node);
  }
  return <>{node}</>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PluginAppRoot />
  </React.StrictMode>
);
