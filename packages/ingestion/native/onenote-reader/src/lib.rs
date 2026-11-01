use onenote_parser::Parser;
use onenote_parser::contents::{
    Content, EmbeddedFile, Image, Outline, OutlineElement, OutlineItem, Table,
};
use onenote_parser::page::PageContent;
use onenote_parser::errors::Error as ParseError;
use onenote_parser::section::Section;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;
use typed_path::TypedPath;

pub const MANIFEST_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const PAGE_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const ASSET_MAX_BYTES: usize = 32 * 1024 * 1024;
pub const SNAPSHOT_MAX_BYTES: u64 = 512 * 1024 * 1024;
const MAX_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_CAB_ENTRIES: usize = 1_000;
const MAX_SECTIONS: usize = 1_000;
const MAX_PAGES: usize = 20_000;
const MAX_PATH_DEPTH: usize = 20;
const MAX_BLOCKS: usize = 25_000;
const MAX_TEXT_CHARS: usize = 200_000;
const MAX_WARNINGS: usize = 100;
pub const EMPTY_SECTION_WARNING: &str =
    "section has no saved content; open it in OneNote and export the notebook again";
// The parser's only signal for a section whose content revision was never stored,
// e.g. a cloud section OneNote had not downloaded when the notebook was exported.
const NO_REVISION_ERROR: &str = "Malformed OneStore data: ObjectSpaceManifestListReferenceFND must point to a list with at least one revision";

#[derive(Debug, thiserror::Error)]
pub enum ReaderError {
    #[error("invalid command input")]
    InvalidInput,
    #[error("source file is too large")]
    SourceTooLarge,
    #[error("output directory must exist and be empty")]
    OutputNotEmpty,
    #[error("the OneNote package is malformed or unsafe")]
    MalformedPackage,
    #[error("the OneNote snapshot exceeds reader limits")]
    ResourceLimit,
    #[error("the OneNote file could not be read")]
    Parse,
    #[error("the OneNote reader exceeded its time limit")]
    Timeout,
    #[error("the OneNote snapshot could not be written")]
    Io,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Block {
    Text {
        text: String,
    },
    Table {
        rows: Vec<Vec<String>>,
    },
    #[serde(rename_all = "camelCase")]
    Image {
        asset_id: String,
        alt: String,
    },
    #[serde(rename_all = "camelCase")]
    Attachment {
        name: String,
        byte_size: u64,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageFile {
    id: String,
    section_id: String,
    title: String,
    level: i32,
    blocks: Vec<Block>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
struct PageSummary {
    id: String,
    title: String,
    level: i32,
    text: String,
}

#[derive(Serialize)]
struct ManifestSection {
    id: String,
    title: String,
    path: Vec<String>,
    pages: Vec<PageSummary>,
    warnings: Vec<String>,
    content: SectionContent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SectionContent {
    Parsed,
    Empty,
    Unreadable,
}

pub fn classify_section(result: Result<Section, ParseError>) -> Result<Section, SectionContent> {
    result.map_err(|error| {
        if error.to_string() == NO_REVISION_ERROR {
            SectionContent::Empty
        } else {
            SectionContent::Unreadable
        }
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestAsset {
    id: String,
    content_type: &'static str,
    byte_size: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u8,
    sections: Vec<ManifestSection>,
    assets: Vec<ManifestAsset>,
    warnings: Vec<String>,
}

struct SnapshotWriter {
    output: PathBuf,
    assets: Vec<ManifestAsset>,
    asset_ids: HashSet<String>,
    bytes_written: u64,
    page_count: usize,
    next_page: usize,
}

struct PageBuild {
    blocks: Vec<Block>,
    warnings: Vec<String>,
    text: String,
    error: Option<ReaderError>,
}

struct CabEntry {
    raw_name: String,
    normalized: String,
    size: u64,
}

pub fn run(source: &Path, output: &Path) -> Result<(), ReaderError> {
    validate_paths(source, output)?;
    let mut header = [0u8; 4];
    File::open(source)
        .and_then(|mut file| file.read_exact(&mut header))
        .map_err(|_| ReaderError::Parse)?;

    fs::create_dir(output.join("pages")).map_err(|_| ReaderError::Io)?;
    fs::create_dir(output.join("assets")).map_err(|_| ReaderError::Io)?;
    let mut writer = SnapshotWriter {
        output: output.to_path_buf(),
        assets: Vec::new(),
        asset_ids: HashSet::new(),
        bytes_written: 0,
        page_count: 0,
        next_page: 0,
    };
    let sections = if &header == b"MSCF" {
        read_package(source, &mut writer)?
    } else {
        vec![read_standalone(source, &mut writer)?]
    };

    if !sections
        .iter()
        .any(|section| section.content == SectionContent::Parsed)
    {
        return Err(ReaderError::Parse);
    }
    let count = |content| {
        sections
            .iter()
            .filter(|section| section.content == content)
            .count()
    };
    let mut warnings = Vec::new();
    let empty = count(SectionContent::Empty);
    if empty > 0 {
        warnings.push(format!("{empty} sections contain no saved content"));
    }
    let unreadable = count(SectionContent::Unreadable);
    if unreadable > 0 {
        warnings.push(format!("{unreadable} sections could not be read"));
    }
    let manifest = Manifest {
        schema_version: 2,
        sections,
        assets: writer.assets,
        warnings,
    };
    let bytes = serde_json::to_vec(&manifest).map_err(|_| ReaderError::Io)?;
    if bytes.len() > MANIFEST_MAX_BYTES
        || writer.bytes_written + bytes.len() as u64 > SNAPSHOT_MAX_BYTES
    {
        return Err(ReaderError::ResourceLimit);
    }
    write_new(&output.join("manifest.json"), &bytes)
}

pub fn run_with_deadline(
    source: PathBuf,
    output: PathBuf,
    timeout: Duration,
) -> Result<(), ReaderError> {
    with_deadline(timeout, move || run(&source, &output)).and_then(|result| result)
}

fn with_deadline<T: Send + 'static>(
    timeout: Duration,
    operation: impl FnOnce() -> T + Send + 'static,
) -> Result<T, ReaderError> {
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = sender.send(operation());
    });
    match receiver.recv_timeout(timeout) {
        Ok(result) => Ok(result),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(ReaderError::Timeout),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(ReaderError::Parse),
    }
}

#[cfg(target_os = "linux")]
pub fn arm_parent_death_signal() -> Result<(), ReaderError> {
    // SAFETY: prctl/getppid take no borrowed pointers for these operations.
    unsafe {
        let parent = libc::getppid();
        if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
            return Err(ReaderError::InvalidInput);
        }
        if parent <= 1 || libc::getppid() != parent {
            return Err(ReaderError::InvalidInput);
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn arm_parent_death_signal() -> Result<(), ReaderError> {
    Ok(())
}

fn validate_paths(source: &Path, output: &Path) -> Result<(), ReaderError> {
    let metadata = fs::metadata(source).map_err(|_| ReaderError::InvalidInput)?;
    if !metadata.is_file() {
        return Err(ReaderError::InvalidInput);
    }
    if metadata.len() > MAX_SOURCE_BYTES {
        return Err(ReaderError::SourceTooLarge);
    }
    let output_meta = fs::metadata(output).map_err(|_| ReaderError::OutputNotEmpty)?;
    if !output_meta.is_dir()
        || fs::read_dir(output)
            .map_err(|_| ReaderError::OutputNotEmpty)?
            .next()
            .is_some()
    {
        return Err(ReaderError::OutputNotEmpty);
    }
    Ok(())
}

fn read_standalone(
    source: &Path,
    writer: &mut SnapshotWriter,
) -> Result<ManifestSection, ReaderError> {
    let path = source.to_str().ok_or(ReaderError::InvalidInput)?;
    let section = classify_section(Parser::new().parse_section(TypedPath::derive(path)));
    let title = section
        .as_ref()
        .ok()
        .map(|section| clamp(section.display_name(), 1_000))
        .unwrap_or_else(|| file_stem(source));
    build_section(
        section,
        "section-000001".to_owned(),
        title,
        Vec::new(),
        writer,
    )
}

fn read_package(
    source: &Path,
    writer: &mut SnapshotWriter,
) -> Result<Vec<ManifestSection>, ReaderError> {
    let file = File::open(source).map_err(|_| ReaderError::Parse)?;
    let mut cabinet =
        cab::Cabinet::new(BufReader::new(file)).map_err(|_| ReaderError::MalformedPackage)?;
    let mut entries = Vec::new();
    let mut expanded = 0u64;
    let mut seen = HashSet::new();
    for entry in cabinet
        .folder_entries()
        .flat_map(|folder| folder.file_entries())
    {
        if entries.len() >= MAX_CAB_ENTRIES {
            return Err(ReaderError::ResourceLimit);
        }
        let normalized =
            normalize_cab_path(entry.name()).map_err(|_| ReaderError::MalformedPackage)?;
        if !seen.insert(normalized.clone()) {
            return Err(ReaderError::MalformedPackage);
        }
        if normalized.split('/').count() > MAX_PATH_DEPTH + 1 {
            return Err(ReaderError::ResourceLimit);
        }
        let size = u64::from(entry.uncompressed_size());
        expanded = expanded
            .checked_add(size)
            .ok_or(ReaderError::ResourceLimit)?;
        if expanded > SNAPSHOT_MAX_BYTES {
            return Err(ReaderError::ResourceLimit);
        }
        entries.push(CabEntry {
            raw_name: entry.name().to_owned(),
            normalized,
            size,
        });
    }

    let mut sections = entries
        .into_iter()
        .filter(|entry| entry.normalized.to_ascii_lowercase().ends_with(".one"))
        .collect::<Vec<_>>();
    sections.sort_by(|a, b| a.normalized.cmp(&b.normalized));
    if sections.is_empty() {
        return Err(ReaderError::MalformedPackage);
    }
    if sections.len() > MAX_SECTIONS {
        return Err(ReaderError::ResourceLimit);
    }

    let mut output = Vec::with_capacity(sections.len());
    for (index, entry) in sections.into_iter().enumerate() {
        let mut bytes = Vec::with_capacity(entry.size.min(usize::MAX as u64) as usize);
        cabinet
            .read_file(&entry.raw_name)
            .and_then(|reader| reader.take(entry.size + 1).read_to_end(&mut bytes))
            .map_err(|_| ReaderError::MalformedPackage)?;
        if bytes.len() as u64 != entry.size {
            return Err(ReaderError::MalformedPackage);
        }
        let parts = entry
            .normalized
            .split('/')
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let title = parts
            .last()
            .map(|name| trim_suffix(name, ".one"))
            .unwrap_or_else(|| "Untitled".to_owned());
        let parents = parts[..parts.len().saturating_sub(1)]
            .iter()
            .map(|part| clamp(part, 255))
            .collect();
        let section = classify_section(
            Parser::new().parse_section_buffer(&bytes, TypedPath::derive(&entry.normalized)),
        );
        output.push(build_section(
            section,
            format!("section-{:06}", index + 1),
            title,
            parents,
            writer,
        )?);
    }
    Ok(output)
}

fn build_section(
    section: Result<Section, SectionContent>,
    id: String,
    title: String,
    path: Vec<String>,
    writer: &mut SnapshotWriter,
) -> Result<ManifestSection, ReaderError> {
    let section = match section {
        Ok(section) => section,
        Err(content) => {
            let warning = if content == SectionContent::Empty {
                EMPTY_SECTION_WARNING
            } else {
                "section could not be parsed"
            };
            return Ok(ManifestSection {
                id,
                title: clamp(&title, 1_000),
                path,
                pages: Vec::new(),
                warnings: vec![warning.to_owned()],
                content,
            });
        }
    };

    let missing = section
        .report()
        .warnings()
        .iter()
        .filter(|warning| {
            warning.message() == "page space is missing; skipping stale page reference"
        })
        .count();
    let other = section.report().warnings().len().saturating_sub(missing);
    let mut section_warnings = Vec::new();
    if missing > 0 {
        push_warning(
            &mut section_warnings,
            format!("{missing} stale page references were skipped"),
        );
    }
    if other > 0 {
        push_warning(
            &mut section_warnings,
            format!("parser reported {other} non-fatal content warnings"),
        );
    }

    let mut summaries = Vec::new();
    for series in section.page_series() {
        for page in series.pages() {
            if writer.page_count >= MAX_PAGES {
                return Err(ReaderError::ResourceLimit);
            }
            writer.next_page += 1;
            writer.page_count += 1;
            let page_id = format!("page-{:06}", writer.next_page);
            let title = clamp(page.title_text().unwrap_or("Untitled"), 1_000);
            let level = page.level().clamp(0, 20);
            let mut build = PageBuild {
                blocks: Vec::new(),
                warnings: Vec::new(),
                text: String::new(),
                error: None,
            };
            for content in page.contents() {
                extract_page_content(content, &mut build, writer);
                if build.blocks.len() >= MAX_BLOCKS {
                    push_warning(&mut build.warnings, "page block limit reached".to_owned());
                    break;
                }
            }
            if let Some(error) = build.error.take() {
                return Err(error);
            }
            let text = build.text;
            let page_file = PageFile {
                id: page_id.clone(),
                section_id: id.clone(),
                title: title.clone(),
                level,
                blocks: build.blocks,
                warnings: build.warnings,
            };
            let bytes = bounded_page_json(page_file)?;
            writer.add_bytes(bytes.len() as u64)?;
            write_new(
                &writer.output.join("pages").join(format!("{page_id}.json")),
                &bytes,
            )?;
            summaries.push(PageSummary {
                id: page_id,
                title,
                level,
                text,
            });
        }
    }
    Ok(ManifestSection {
        id,
        title: clamp(&title, 1_000),
        path,
        pages: summaries,
        warnings: section_warnings,
        content: SectionContent::Parsed,
    })
}

fn extract_page_content(content: &PageContent, build: &mut PageBuild, writer: &mut SnapshotWriter) {
    match content {
        PageContent::Outline(outline) => extract_outline(outline, build, writer),
        PageContent::Image(image) => extract_image(image, build, writer),
        PageContent::EmbeddedFile(file) => extract_attachment(file, build),
        PageContent::Ink(_) => {
            push_warning(&mut build.warnings, "ink content was omitted".to_owned())
        }
        PageContent::Unknown => push_warning(
            &mut build.warnings,
            "unsupported page content was omitted".to_owned(),
        ),
    }
}

fn extract_outline(outline: &Outline, build: &mut PageBuild, writer: &mut SnapshotWriter) {
    for item in outline.items() {
        extract_item(item, build, writer);
    }
}

fn extract_item(item: &OutlineItem, build: &mut PageBuild, writer: &mut SnapshotWriter) {
    match item {
        OutlineItem::Element(element) => extract_element(element, build, writer),
        OutlineItem::Group(group) => {
            for nested in group.outlines() {
                extract_item(nested, build, writer);
            }
        }
    }
}

fn extract_element(element: &OutlineElement, build: &mut PageBuild, writer: &mut SnapshotWriter) {
    for content in element.contents() {
        if build.blocks.len() >= MAX_BLOCKS {
            return;
        }
        match content {
            Content::RichText(text) => {
                let value = clamp(text.text(), MAX_TEXT_CHARS);
                if utf16_len(text.text()) > utf16_len(&value) {
                    push_warning(
                        &mut build.warnings,
                        "text block was truncated to the character limit".to_owned(),
                    );
                }
                if !value.is_empty() {
                    append_search_text(&mut build.text, &value, &mut build.warnings);
                    build.blocks.push(Block::Text { text: value });
                }
                if !text.math_inline_objects().is_empty() {
                    push_warning(&mut build.warnings, "math content was omitted".to_owned());
                }
                if !text.embedded_objects().is_empty() {
                    push_warning(
                        &mut build.warnings,
                        "embedded ink content was omitted".to_owned(),
                    );
                }
            }
            Content::Table(table) => extract_table(table, build, writer),
            Content::Image(image) => extract_image(image, build, writer),
            Content::EmbeddedFile(file) => extract_attachment(file, build),
            Content::Ink(_) => {
                push_warning(&mut build.warnings, "ink content was omitted".to_owned())
            }
            Content::Unknown => push_warning(
                &mut build.warnings,
                "unsupported outline content was omitted".to_owned(),
            ),
        }
    }
    for child in element.children() {
        extract_item(child, build, writer);
    }
}

fn extract_table(table: &Table, build: &mut PageBuild, writer: &mut SnapshotWriter) {
    let mut rows = Vec::new();
    for row in table.contents().iter().take(5_000) {
        let mut cells = Vec::new();
        for cell in row.contents().iter().take(200) {
            let mut text = String::new();
            for element in cell.contents() {
                collect_element_text(element, &mut text);
            }
            let value = clamp(&text, 20_000);
            if utf16_len(&text) > utf16_len(&value) {
                push_warning(
                    &mut build.warnings,
                    "table cell text was truncated to the character limit".to_owned(),
                );
            }
            cells.push(value);
        }
        rows.push(cells);
    }
    if table.contents().len() > 5_000
        || table
            .contents()
            .iter()
            .any(|row| row.contents().len() > 200)
    {
        push_warning(
            &mut build.warnings,
            "table was truncated to reader limits".to_owned(),
        );
    }
    for row in &rows {
        for cell in row {
            append_search_text(&mut build.text, cell, &mut build.warnings);
        }
    }
    build.blocks.push(Block::Table { rows });
    for row in table.contents().iter().take(5_000) {
        for cell in row.contents().iter().take(200) {
            for element in cell.contents() {
                extract_element_media(element, build, writer);
            }
        }
    }
}

fn extract_element_media(
    element: &OutlineElement,
    build: &mut PageBuild,
    writer: &mut SnapshotWriter,
) {
    for content in element.contents() {
        if build.blocks.len() >= MAX_BLOCKS {
            return;
        }
        match content {
            Content::RichText(text) => {
                if !text.math_inline_objects().is_empty() {
                    push_warning(&mut build.warnings, "math content was omitted".to_owned());
                }
                if !text.embedded_objects().is_empty() {
                    push_warning(
                        &mut build.warnings,
                        "embedded ink content was omitted".to_owned(),
                    );
                }
            }
            Content::Table(table) => {
                push_warning(
                    &mut build.warnings,
                    "nested table content was flattened into its parent cell".to_owned(),
                );
                for row in table.contents().iter().take(5_000) {
                    for cell in row.contents().iter().take(200) {
                        for nested in cell.contents() {
                            extract_element_media(nested, build, writer);
                        }
                    }
                }
            }
            Content::Image(image) => extract_image(image, build, writer),
            Content::EmbeddedFile(file) => extract_attachment(file, build),
            Content::Ink(_) => {
                push_warning(&mut build.warnings, "ink content was omitted".to_owned())
            }
            Content::Unknown => push_warning(
                &mut build.warnings,
                "unsupported table-cell content was omitted".to_owned(),
            ),
        }
    }
    for child in element.children() {
        extract_item_media(child, build, writer);
    }
}

fn extract_item_media(item: &OutlineItem, build: &mut PageBuild, writer: &mut SnapshotWriter) {
    match item {
        OutlineItem::Element(element) => extract_element_media(element, build, writer),
        OutlineItem::Group(group) => {
            for nested in group.outlines() {
                extract_item_media(nested, build, writer);
            }
        }
    }
}

fn collect_element_text(element: &OutlineElement, output: &mut String) {
    for content in element.contents() {
        match content {
            Content::RichText(text) => append_line(output, text.text()),
            Content::Table(table) => {
                for row in table.contents() {
                    for cell in row.contents() {
                        for nested in cell.contents() {
                            collect_element_text(nested, output);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    for child in element.children() {
        collect_item_text(child, output);
    }
}

fn collect_item_text(item: &OutlineItem, output: &mut String) {
    match item {
        OutlineItem::Element(element) => collect_element_text(element, output),
        OutlineItem::Group(group) => {
            for nested in group.outlines() {
                collect_item_text(nested, output);
            }
        }
    }
}

fn extract_image(image: &Image, build: &mut PageBuild, writer: &mut SnapshotWriter) {
    if image.text().is_some_and(|text| !text.trim().is_empty()) {
        push_warning(
            &mut build.warnings,
            "embedded image OCR text was not added to searchable text".to_owned(),
        );
    }
    if !image.embeds().is_empty() {
        push_warning(
            &mut build.warnings,
            "embedded web content was omitted".to_owned(),
        );
    }
    let primary = read_payload(image.read());
    let web = read_payload(image.web_picture().map(|picture| picture.read()));
    let (bytes, content_type) = match choose_image_payload(primary, web) {
        ImagePayload::Image(bytes, content_type) => (bytes, content_type),
        omitted => {
            push_warning(&mut build.warnings, omitted.warning().to_owned());
            return;
        }
    };
    match writer.write_asset(&bytes, content_type) {
        Ok(asset_id) => build.blocks.push(Block::Image {
            asset_id,
            alt: clamp(image.alt_text().unwrap_or(""), 1_000),
        }),
        Err(error) => build.error = Some(error),
    }
}

/// What an image object yielded: a displayable image, or why it was omitted.
#[derive(Debug, PartialEq, Eq)]
pub enum ImagePayload {
    Image(Vec<u8>, &'static str),
    Missing,
    Unsupported,
    TooLarge,
    Unreadable,
}

impl ImagePayload {
    fn warning(&self) -> &'static str {
        match self {
            ImagePayload::Image(..) => "",
            ImagePayload::Missing => "image data is not included in the notebook file",
            ImagePayload::Unsupported => "unsupported image format was omitted",
            ImagePayload::TooLarge => "image payload exceeded the asset limit",
            ImagePayload::Unreadable => "image payload could not be read",
        }
    }
}

fn read_payload(reader: Option<Box<dyn Read>>) -> ImagePayload {
    let Some(reader) = reader else {
        return ImagePayload::Missing;
    };
    let mut bytes = Vec::new();
    if reader
        .take(ASSET_MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return ImagePayload::Unreadable;
    }
    if bytes.len() > ASSET_MAX_BYTES {
        return ImagePayload::TooLarge;
    }
    if bytes.is_empty() {
        return ImagePayload::Missing;
    }
    match image_content_type(&bytes) {
        Some(content_type) => ImagePayload::Image(bytes, content_type),
        None => ImagePayload::Unsupported,
    }
}

/// OneNote stores some pictures in a format browsers cannot show (or not at
/// all) and keeps a displayable "web picture" beside them; use it then.
pub fn choose_image_payload(primary: ImagePayload, web: ImagePayload) -> ImagePayload {
    match (primary, web) {
        (primary @ ImagePayload::Image(..), _) => primary,
        (_, web @ ImagePayload::Image(..)) => web,
        (ImagePayload::Missing, web) => web,
        (primary, _) => primary,
    }
}

fn extract_attachment(file: &EmbeddedFile, build: &mut PageBuild) {
    build.blocks.push(Block::Attachment {
        name: clamp(file.filename(), 500),
        byte_size: file.size(),
    });
}

impl SnapshotWriter {
    fn add_bytes(&mut self, bytes: u64) -> Result<(), ReaderError> {
        self.bytes_written = self
            .bytes_written
            .checked_add(bytes)
            .ok_or(ReaderError::ResourceLimit)?;
        if self.bytes_written > SNAPSHOT_MAX_BYTES {
            return Err(ReaderError::ResourceLimit);
        }
        Ok(())
    }

    fn write_asset(
        &mut self,
        bytes: &[u8],
        content_type: &'static str,
    ) -> Result<String, ReaderError> {
        let id = hex::encode(Sha256::digest(bytes));
        if self.asset_ids.insert(id.clone()) {
            self.add_bytes(bytes.len() as u64)?;
            write_new(&self.output.join("assets").join(&id), bytes)?;
            self.assets.push(ManifestAsset {
                id: id.clone(),
                content_type,
                byte_size: bytes.len(),
            });
        }
        Ok(id)
    }
}

fn bounded_page_json(mut page: PageFile) -> Result<Vec<u8>, ReaderError> {
    loop {
        let bytes = serde_json::to_vec(&page).map_err(|_| ReaderError::Io)?;
        if bytes.len() <= PAGE_MAX_BYTES {
            return Ok(bytes);
        }
        if page.blocks.pop().is_none() {
            return Err(ReaderError::ResourceLimit);
        }
        push_warning(
            &mut page.warnings,
            "page blocks were truncated to the serialized size limit".to_owned(),
        );
    }
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), ReaderError> {
    let mut file = File::options()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| ReaderError::Io)?;
    file.write_all(bytes).map_err(|_| ReaderError::Io)
}

fn append_search_text(target: &mut String, value: &str, warnings: &mut Vec<String>) {
    if value.is_empty() {
        return;
    }
    if utf16_len(target) >= MAX_TEXT_CHARS {
        push_warning(warnings, "searchable page text was truncated".to_owned());
        return;
    }
    if !target.is_empty() {
        target.push('\n');
    }
    let remaining = MAX_TEXT_CHARS.saturating_sub(utf16_len(target));
    let original = utf16_len(value);
    let value = clamp(value, remaining);
    target.push_str(&value);
    if utf16_len(&value) < original {
        push_warning(warnings, "searchable page text was truncated".to_owned());
    }
}

fn append_line(target: &mut String, value: &str) {
    if value.is_empty() {
        return;
    }
    if !target.is_empty() {
        target.push('\n');
    }
    target.push_str(value);
}

fn push_warning(warnings: &mut Vec<String>, warning: String) {
    if warnings.len() < MAX_WARNINGS && !warnings.iter().any(|item| item == &warning) {
        warnings.push(clamp(&warning, 500));
    }
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn clamp(value: &str, max: usize) -> String {
    let mut used = 0;
    value
        .chars()
        .take_while(|character| {
            let next = used + character.len_utf16();
            if next > max {
                false
            } else {
                used = next;
                true
            }
        })
        .collect()
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|name| name.to_str())
        .map(|name| clamp(name, 1_000))
        .unwrap_or_else(|| "Untitled".to_owned())
}

fn trim_suffix(value: &str, suffix: &str) -> String {
    if value
        .to_ascii_lowercase()
        .ends_with(&suffix.to_ascii_lowercase())
    {
        value[..value.len() - suffix.len()].to_owned()
    } else {
        value.to_owned()
    }
}

pub fn normalize_cab_path(name: &str) -> Result<String, &'static str> {
    if name.starts_with(['/', '\\']) || name.as_bytes().get(1) == Some(&b':') {
        return Err("absolute cabinet path");
    }
    let normalized = name.replace('\\', "/");
    let mut parts = Vec::new();
    for component in Path::new(&normalized).components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("cabinet path escapes root");
            }
        }
    }
    if parts.is_empty() {
        return Err("empty cabinet path");
    }
    Ok(parts.join("/"))
}

pub fn image_content_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use onenote_parser::errors::ErrorKind;

    #[test]
    fn web_picture_replaces_an_undisplayable_or_missing_primary() {
        let png = b"\x89PNG\r\n\x1a\n1234".to_vec();
        let web = || ImagePayload::Image(png.clone(), "image/png");
        assert_eq!(
            choose_image_payload(ImagePayload::Unsupported, web()),
            web()
        );
        assert_eq!(choose_image_payload(ImagePayload::Missing, web()), web());
        let jpeg = ImagePayload::Image(vec![0xff, 0xd8, 0xff, 0], "image/jpeg");
        assert_eq!(
            choose_image_payload(jpeg, web()),
            ImagePayload::Image(vec![0xff, 0xd8, 0xff, 0], "image/jpeg")
        );
    }

    #[test]
    fn omitted_images_keep_the_most_specific_reason() {
        assert_eq!(
            choose_image_payload(ImagePayload::Missing, ImagePayload::Missing),
            ImagePayload::Missing
        );
        assert_eq!(
            choose_image_payload(ImagePayload::Unsupported, ImagePayload::Missing),
            ImagePayload::Unsupported
        );
        assert_eq!(
            choose_image_payload(ImagePayload::Missing, ImagePayload::TooLarge),
            ImagePayload::TooLarge
        );
    }

    #[test]
    fn payloads_are_classified_by_their_bytes() {
        let read = |bytes: &[u8]| {
            read_payload(Some(Box::new(std::io::Cursor::new(bytes.to_vec()))))
        };
        assert_eq!(read(b""), ImagePayload::Missing);
        assert_eq!(read(b"PK\x03\x04zip"), ImagePayload::Unsupported);
        assert!(matches!(read(b"GIF89a..."), ImagePayload::Image(_, "image/gif")));
        assert_eq!(read_payload(None), ImagePayload::Missing);
    }

    #[test]
    fn section_without_a_stored_revision_is_empty() {
        let error: ParseError = ErrorKind::MalformedOneStoreData(
            "ObjectSpaceManifestListReferenceFND must point to a list with at least one revision"
                .into(),
        )
        .into();
        assert_eq!(
            classify_section(Err(error)).err(),
            Some(SectionContent::Empty)
        );
    }

    #[test]
    fn other_section_parse_errors_are_unreadable() {
        let error: ParseError = ErrorKind::MalformedOneStoreData("broken".into()).into();
        assert_eq!(
            classify_section(Err(error)).err(),
            Some(SectionContent::Unreadable)
        );
    }

    #[test]
    fn cabinet_paths_reject_escape_and_absolute_forms() {
        for path in [
            "../escape.one",
            "a/../../escape.one",
            "/root.one",
            r"C:\root.one",
        ] {
            assert!(normalize_cab_path(path).is_err(), "accepted {path:?}");
        }
    }

    #[test]
    fn cabinet_paths_normalize_windows_separators() {
        assert_eq!(
            normalize_cab_path(r"group\section.one").unwrap(),
            "group/section.one"
        );
    }

    #[test]
    fn image_type_is_derived_from_payload_magic() {
        assert_eq!(
            image_content_type(b"\x89PNG\r\n\x1a\nrest"),
            Some("image/png")
        );
        assert_eq!(image_content_type(b"\xff\xd8\xffrest"), Some("image/jpeg"));
        assert_eq!(image_content_type(b"GIF89arest"), Some("image/gif"));
        assert_eq!(
            image_content_type(b"RIFF\x04\0\0\0WEBPrest"),
            Some("image/webp")
        );
        assert_eq!(image_content_type(b"BMunsupported"), None);
    }

    #[test]
    fn nonempty_output_is_rejected_before_writes() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.one");
        fs::write(&source, b"not a OneNote file").unwrap();
        let output = temp.path().join("out");
        fs::create_dir(&output).unwrap();
        fs::write(output.join("keep"), b"user data").unwrap();
        assert!(matches!(
            run(&source, &output),
            Err(ReaderError::OutputNotEmpty)
        ));
        assert_eq!(fs::read(output.join("keep")).unwrap(), b"user data");
    }

    #[test]
    fn malformed_cab_has_a_safe_failure() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::write(&source, b"MSCF malformed").unwrap();
        let output = temp.path().join("out");
        fs::create_dir(&output).unwrap();
        assert!(matches!(
            run(&source, &output),
            Err(ReaderError::MalformedPackage)
        ));
    }

    #[test]
    fn malformed_standalone_is_not_published_as_an_empty_notebook() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::write(&source, b"not a OneNote file").unwrap();
        let output = temp.path().join("out");
        fs::create_dir(&output).unwrap();
        assert!(matches!(run(&source, &output), Err(ReaderError::Parse)));
        assert!(!output.join("manifest.json").exists());
    }

    #[test]
    fn package_with_no_readable_sections_is_not_published() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let mut builder = cab::CabinetBuilder::new();
        builder
            .add_folder(cab::CompressionType::None)
            .add_file("Broken.one");
        let mut cabinet = builder.build(File::create(&source).unwrap()).unwrap();
        while let Some(mut entry) = cabinet.next_file().unwrap() {
            entry.write_all(b"not a OneNote section").unwrap();
        }
        cabinet.finish().unwrap();
        let output = temp.path().join("out");
        fs::create_dir(&output).unwrap();
        assert!(matches!(run(&source, &output), Err(ReaderError::Parse)));
        assert!(!output.join("manifest.json").exists());
    }

    #[test]
    fn oversized_source_is_rejected_before_output_writes() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        File::create(&source)
            .unwrap()
            .set_len(MAX_SOURCE_BYTES + 1)
            .unwrap();
        let output = temp.path().join("out");
        fs::create_dir(&output).unwrap();
        assert!(matches!(
            run(&source, &output),
            Err(ReaderError::SourceTooLarge)
        ));
        assert!(fs::read_dir(output).unwrap().next().is_none());
    }

    #[test]
    fn block_json_matches_the_snapshot_contract() {
        let blocks = vec![
            Block::Table {
                rows: vec![vec!["cell".to_owned()]],
            },
            Block::Image {
                asset_id: "a".repeat(64),
                alt: "diagram".to_owned(),
            },
            Block::Attachment {
                name: "notes.txt".to_owned(),
                byte_size: 7,
            },
        ];
        let value = serde_json::to_value(blocks).unwrap();
        assert_eq!(
            value[0],
            serde_json::json!({"kind":"table","rows":[["cell"]]})
        );
        assert_eq!(
            value[1],
            serde_json::json!({"kind":"image","assetId":"a".repeat(64),"alt":"diagram"})
        );
        assert_eq!(
            value[2],
            serde_json::json!({"kind":"attachment","name":"notes.txt","byteSize":7})
        );
    }

    #[test]
    fn string_limits_count_utf16_code_units() {
        assert_eq!(clamp("a😀b", 3), "a😀");
        assert_eq!(clamp("a😀b", 2), "a");
        assert_eq!(utf16_len(&clamp("😀😀", 3)), 2);
    }

    #[test]
    fn full_search_text_reports_additional_omitted_text() {
        let mut text = "a".repeat(MAX_TEXT_CHARS);
        let mut warnings = Vec::new();
        append_search_text(&mut text, "omitted", &mut warnings);
        assert_eq!(utf16_len(&text), MAX_TEXT_CHARS);
        assert_eq!(warnings, ["searchable page text was truncated"]);
    }

    #[test]
    fn native_deadline_expires_a_stalled_operation() {
        let result = with_deadline(Duration::from_millis(1), || {
            std::thread::sleep(Duration::from_millis(100));
        });
        assert!(matches!(result, Err(ReaderError::Timeout)));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_process_arms_parent_death_signal() {
        arm_parent_death_signal().unwrap();
        let mut signal = 0;
        // SAFETY: PR_GET_PDEATHSIG writes one integer to the supplied pointer.
        let result = unsafe { libc::prctl(libc::PR_GET_PDEATHSIG, &mut signal) };
        assert_eq!(result, 0);
        assert_eq!(signal, libc::SIGKILL);
    }
}
