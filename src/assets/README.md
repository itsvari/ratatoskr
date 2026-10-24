# Preview image font

`inter.ttf.bin` is the unmodified Inter variable TrueType font from [Google Fonts](https://github.com/google/fonts/blob/0b58fb370093f9a9f4ff785d94405710b79de67c/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf), bundled under the SIL Open Font License in `OFL.txt`. The `.bin` suffix imports it as a Workers binary module in both Vite and Wrangler, keeping image generation independent of network fetches and static asset routing.

## International fallbacks

The committed `fallbacks/` binaries derive from [Noto Sans Arabic](https://github.com/google/fonts/tree/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/notosansarabic) and [Noto Sans SC](https://github.com/google/fonts/tree/a85815a42757630ce188fdad368c2dfc444d4773/ofl/notosanssc), under the accompanying SIL OFL licences. Family names are changed to Preview Arabic / Preview CJK for these derived fonts. Arabic keeps its complete shaping and mark-positioning tables. CJK coverage from U+2E80 upwards is divided into 256-codepoint pages, including supported supplementary ideographs. The renderer loads only the pages used by the current text into its font database; all binaries are bundled locally, with no font requests or rendering services.

Normal Node/Bun builds consume the committed binaries. To regenerate them, install Python fontTools, download the two variable TTFs from the pinned source revisions, then run:

```sh
python scripts/subset-preview-fonts.py /path/to/NotoSansSC\[wght\].ttf /path/to/NotoSansArabic\[wdth,wght\].ttf
```

Inter remains the primary Latin/Greek/Cyrillic font. These fallbacks add Arabic and the source SC font's CJK coverage; they are not a universal Unicode/colour-emoji font collection. Names are not restricted to these scripts. A deployer needing another script should bundle a font with its shaping tables and extend the fallback selector.
