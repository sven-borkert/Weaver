# Weaver OneNote reader

`weaver-onenote-reader` converts a standalone `.one` section or a `.onepkg`
CAB archive into Weaver's bounded notebook snapshot format. The CLI writes no
successful output to stdout:

```sh
weaver-onenote-reader --source <file> --output <empty-directory>
```

The vendored `onenote_parser` source is MPL-2.0 code from
`emsi/onenote.rs@77cf881df7579eb58972e3db8ce0ca34d25a7f62`. Its upstream license is
at `vendor/onenote_parser/LICENSE`; `vendor/onenote_parser/WEAVER_PATCH.md`
documents Weaver's narrow stale-page-reference recovery patch.
