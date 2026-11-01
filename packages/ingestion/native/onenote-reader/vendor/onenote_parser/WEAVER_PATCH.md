# Weaver patch

This is `crates/parser` from `emsi/onenote.rs` commit
`77cf881df7579eb58972e3db8ce0ca34d25a7f62`, under the upstream MPL-2.0
license.

Weaver changes `src/onenote/page_series.rs` so a page-series reference whose
object space is absent becomes a non-fatal parser warning. OneNote files can
retain these stale references; upstream otherwise aborts the entire section.
All other page parse errors remain fatal.

One inherited documentation comment also has trailing whitespace removed.
