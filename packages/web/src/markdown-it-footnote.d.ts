// markdown-it-footnote ships no types, and @types/markdown-it-footnote is written against markdown-it 13's.
declare module 'markdown-it-footnote' {
  import type { PluginSimple } from 'markdown-it';

  const footnote: PluginSimple;
  export default footnote;
}
