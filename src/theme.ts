import { createSignal } from 'solid-js';

export type ThemeName = 'dark' | 'light';

const STORAGE_KEY = 'shaderlab-theme';
const colorScheme = window.matchMedia('(prefers-color-scheme: light)');

function systemTheme(): ThemeName {
  return colorScheme.matches ? 'light' : 'dark';
}

function loadInitialTheme(): ThemeName {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === 'light' || saved === 'dark' ? saved : systemTheme();
}

export const [theme, setTheme] = createSignal<ThemeName>(loadInitialTheme());

function renderTheme(next: ThemeName) {
  setTheme(next);
  document.documentElement.dataset.theme = next;
}

export function applyTheme(next: ThemeName) {
  renderTheme(next);
  localStorage.setItem(STORAGE_KEY, next);
}

export function toggleTheme() {
  applyTheme(theme() === 'dark' ? 'light' : 'dark');
}

// 用户尚未做出显式选择时，主题随系统实时变化。
colorScheme.addEventListener('change', () => {
  if (!localStorage.getItem(STORAGE_KEY)) renderTheme(systemTheme());
});

renderTheme(theme());
