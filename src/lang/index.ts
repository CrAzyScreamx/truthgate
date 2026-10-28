import type { Lang, LanguageAdapter } from '../contract.ts';
import { csharpAdapter } from './csharp/adapter.ts';
import { goAdapter } from './go/adapter.ts';
import { javaAdapter } from './java/adapter.ts';
import { jsAdapterJs, tsAdapter } from './js/adapter.ts';
import { pythonAdapter } from './python/adapter.ts';
import { rustAdapter } from './rust/adapter.ts';

export const adapters: LanguageAdapter[] = [pythonAdapter, tsAdapter, jsAdapterJs, javaAdapter, csharpAdapter, goAdapter, rustAdapter];

export function getAdapter(lang: Lang): LanguageAdapter {
  const a = adapters.find((x) => x.lang === lang);
  if (!a) throw new Error(`unknown language "${lang}"`);
  return a;
}
