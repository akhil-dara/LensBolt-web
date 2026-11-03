//! Browser sender: the page hands a file's bytes to `WebSender`, asks for frames one at a time, and
//! paints each frame (RGBA, tile size) on a canvas. All of the codec runs in WebAssembly; the page
//! only schedules frames at the chosen rate.
use lensbolt_core::calib::{CodeError, Config, CALIB_FIRST};
use lensbolt_core::file::BatchSource;
use lensbolt_core::finish::{parts_text, FinishError};
use lensbolt_core::words::{word_index, WordError, WORDS};
use lensbolt_core::flat::{render_to, Alphabet, CellFormat, FlatGrid, FlatSender, FlatSenderConfig, MANIFEST_EVERY_FRAMES, MANIFEST_FORMAT};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

// 3 px black/white: the format measured live on a Full HD phone camera (2026-10-29: 3 MB SHA-identical); colour
// cells fail there (4:2:0 chroma, 2.2% cell errors on chroma pairs)
const DEFAULT_FORMAT: CellFormat = CellFormat { pitch: 3, alphabet: Alphabet::Bw };
// the core's default (odd: a camera at exactly half the page's rate still sees manifests)
const MANIFEST_EVERY: u32 = MANIFEST_EVERY_FRAMES;

/// 32 fresh bits: Date.now() mixed with crypto.getRandomValues (Date.now() alone where the page has no crypto).
fn repair_entropy() -> u32 {
    let now = js_sys::Date::now() as u64;
    let buf = js_sys::Uint32Array::new_with_length(1);
    let crypto = js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("crypto")).ok().filter(|c| c.is_object());
    let random = crypto.and_then(|c| {
        let f: js_sys::Function = js_sys::Reflect::get(&c, &JsValue::from_str("getRandomValues")).ok()?.dyn_into().ok()?;
        f.call1(&c, &buf).ok().map(|_| buf.get_index(0))
    });
    let t = (now ^ (now >> 32)) as u32;
    t.wrapping_mul(0x9E37_79B9) ^ random.unwrap_or(0)
}

#[wasm_bindgen]
pub struct WebSender { sender: FlatSender, width: u32, height: u32, fps: u32 }

#[wasm_bindgen]
impl WebSender {
    /// `width` x `height`: the tile in screen px (1024x1024 is the standard; multiples of 8, >= 256).
    /// `code`: the receiver's two calibration words, or empty for the blind default (3 px black/white,
    /// 30 fps). `calibration`: show the opening carousel instead.
    #[wasm_bindgen(constructor)]
    pub fn new(filename: &str, data: Vec<u8>, width: u32, height: u32, code: &str, calibration: bool) -> Result<WebSender, JsValue> {
        let (cfg, fps) = sender_config(width, height, code, calibration)?;
        let sender = FlatSender::from_bytes(filename, data, cfg).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(WebSender { sender, width, height, fps })
    }
    /// The files `ids` of `files` (the page's list, in its order) as one transfer: one file is sent exactly as
    /// `new` sends it; several are a batch (the file list first, then the files, smallest first; named after the
    /// first, "a.jpg +2 more"). Every sender shares the bytes `files` holds: making one again (a refit, Start after
    /// Stop) copies nothing. Refused while a file is still being read.
    pub fn from_files(files: &WebFiles, ids: &[u32], width: u32, height: u32, code: &str, calibration: bool) -> Result<WebSender, JsValue> {
        let (cfg, fps) = sender_config(width, height, code, calibration)?;
        let mut chosen = Vec::with_capacity(ids.len());
        for id in ids {
            match files.files.get(id) {
                Some(StoredFile { name, data: Fill::Done(d), hash: Hash::Done(h), .. }) => chosen.push((name.clone(), d.clone(), h.clone())),
                Some(_) => return Err(JsValue::from_str("A file is still being read. Start again in a moment.")),
                None => return Err(JsValue::from_str("A file of the list is no longer held. Add it again.")),
            }
        }
        let err = |e: std::io::Error| JsValue::from_str(&e.to_string());
        let sender = match chosen.len() {
            0 => return Err(JsValue::from_str("Choose a file first.")),
            // the hashes computed as each file was read: the files are not read again here
            1 => { let (name, data, h) = chosen.pop().expect("one file"); FlatSender::from_shared_hashed(&name, data, h, cfg).map_err(err)? }
            _ => FlatSender::from_batch("", chosen.into_iter().map(|(n, d, h)| (n, BatchSource::Hashed(d, h.file))).collect(), cfg).map_err(err)?,
        };
        Ok(WebSender { sender, width, height, fps })
    }
    /// The Tune carousel for a tile of `width` x `height` (`FlatSender::tune`): no file, a fixed 256-frame loop whose
    /// frames each name their format and rate by their number. `display_60`: the page measured a 60 or 120 Hz screen
    /// (the 60 fps segments are drawn at 60, else at 30). Show each frame for `1000 / frame_fps()` ms.
    pub fn tune(width: u32, height: u32, display_60: bool) -> Result<WebSender, JsValue> {
        let cfg = FlatSenderConfig { width, height, manifest_every_frames: MANIFEST_EVERY, repair_offset: Some(repair_entropy()), ..FlatSenderConfig::default() };
        let sender = FlatSender::tune(cfg, display_60).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(WebSender { sender, width, height, fps: 30 })
    }
    /// The rate the frame last returned is shown at: a Tune frame's own (`FlatSender::tune_frame_fps`; the countdown's
    /// held frames 30), else the configured rate.
    pub fn frame_fps(&self) -> u32 { self.sender.tune_frame_fps().unwrap_or(self.fps) }
    /// What the receiver shows as the transfer's name: the file's, or the batch's ("a.jpg +2 more").
    pub fn name(&self) -> String { self.sender.manifest().filename.clone() }
    /// Files in this transfer: 1 for one file, the batch's count otherwise.
    pub fn file_count(&self) -> u32 { self.sender.batch_index().map_or(1, |i| i.entries.len() as u32) }
    /// This transfer's id and number of parts, "id,parts", as the free `finish_context` gives them for one file
    /// (a batch too): for tests and tools, with `finish_code`.
    pub fn finish_context(&self) -> String { format!("{},{}", self.sender.config().transfer_id, self.sender.manifest().finish_units()) }
    /// Frames in one complete pass over the file (for the progress display).
    pub fn frames_per_pass(&self) -> u32 { self.sender.frames_per_pass() as u32 }
    pub fn frames_emitted(&self) -> u32 { self.sender.frames_emitted() as u32 }
    /// Display rate the configuration asks for.
    pub fn fps(&self) -> u32 { self.fps }
    pub fn file_size(&self) -> f64 { self.sender.manifest().file_size as f64 }
    pub fn stream_size(&self) -> f64 { self.sender.manifest().stream_size as f64 }
    /// The next frame as RGBA bytes, `width * height * 4`, ready for `ImageData`.
    pub fn next_frame_rgba(&mut self) -> Result<Vec<u8>, JsValue> {
        let frame = self.sender.next_frame().map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(self.rgba(&frame))
    }
    /// The countdown's frame: the manifest again under the next frame number (one per displayed frame while
    /// the first frame is held), so the phone measures this sender's frame rate while the user aims. The data
    /// schedule does not move.
    pub fn hold_frame_rgba(&mut self) -> Vec<u8> {
        let frame = self.sender.hold_manifest_frame();
        self.rgba(&frame)
    }
    /// Finish words from the receiver: from the next data frame on, only the parts they name are sent (repair
    /// packets from this sender's own fresh offset, so a sender started again sends packets the receiver does not
    /// have yet). Returns what they mean: for one file "3 parts: 7, 12, 30" (part numbers from 1), for a batch the
    /// files in those parts, "3 files: a.jpg, b.pdf +1" (`FlatSender::units_text`); a refused code, one naming
    /// nothing included, changes nothing and the error says why in plain words.
    pub fn finish(&mut self, code: &str) -> Result<String, JsValue> {
        let err = |e: FinishError| JsValue::from_str(&finish_error(code, e));
        let units = lensbolt_core::finish::decode(self.sender.config().transfer_id, self.sender.manifest().finish_units(), code).map_err(err)?;
        if units.is_empty() { return Err(JsValue::from_str(NOTHING_NAMED)); }
        self.sender.finish(code).map_err(err)?;
        Ok(self.sender.units_text(&units))
    }
    /// Back to the normal schedule (every part), where it left off.
    pub fn send_everything(&mut self) { self.sender.send_everything(); }
    /// The parts being sent after finish words, as `finish` described them; empty while sending everything.
    pub fn finishing(&self) -> String { self.sender.focus().map(|u| self.sender.units_text(u)).unwrap_or_default() }
    /// True once the named parts have all had their repair rounds and the sender went back to every part by
    /// itself (the page then asks for the phone's new words); false while they are sent, and after new words.
    pub fn focus_done(&self) -> bool { self.sender.focus_done() }
    fn rgba(&self, frame: &lensbolt_core::flat::FlatFrame) -> Vec<u8> {
        let img = render_to(frame, self.width, self.height);
        let mut out = Vec::with_capacity(img.data.len() / 3 * 4);
        for px in img.data.chunks_exact(3) { out.extend_from_slice(&[px[0], px[1], px[2], 255]); }
        out
    }
}

/// The sender's configuration for a tile of `width` x `height` and calibration words `code` (empty: the blind
/// default), and the frame rate it sends at. The transfer id comes from the content (0), so a reloaded page resumes
/// the same transfer; the repair offset is fresh, so a reloaded sender's finish-word packets are new to the receiver.
fn sender_config(width: u32, height: u32, code: &str, calibration: bool) -> Result<(FlatSenderConfig, u32), JsValue> {
    let mut cfg = FlatSenderConfig { width, height, format: DEFAULT_FORMAT, manifest_every_frames: MANIFEST_EVERY, calibration, transfer_id: 0, repair_offset: Some(repair_entropy()), ..FlatSenderConfig::default() };
    let mut fps = 30;
    if !code.trim().is_empty() {
        let c = Config::from_code(code).map_err(|e| JsValue::from_str(&code_error(code, e)))?;
        cfg.format = c.format(); cfg.calibration = false;
        fps = c.fps_value();
    }
    Ok((cfg, fps))
}

/// The files chosen on the page, each held once in this module's memory for as long as it is on the list. The page
/// reads a file a piece at a time (`begin`, `append` of a few MiB each, `finish`), so the tab never holds a whole
/// file in JavaScript as well; every sender made from the list (`WebSender::from_files`) shares these bytes.
/// Memory: the files' sizes, plus one piece while a file is read. A file this tab cannot hold, with `HEADROOM` to spare
/// for sending, is refused when it is begun (no memory is taken and the module keeps working): WebAssembly gives a page
/// at most 4 GB, one file at most 2 GB. A file added twice is held once: the page passes the same id twice. Each file's
/// hashes (the file's SHA-256, and each 16 MiB segment's) are computed as its pieces arrive, once: the page shows the
/// SHA-256 under the name when the file is read (`sha256`), and a sender made from the list does not hash it again.
#[wasm_bindgen]
pub struct WebFiles { files: BTreeMap<u32, StoredFile>, next: u32 }
struct StoredFile { name: String, size: usize, data: Fill, hash: Hash }
/// A file's SHA-256: running while it is read, then its digest.
enum Hash { Running(Box<lensbolt_core::file::FileHasher>), Done(lensbolt_core::file::FileHashes) }
/// A file being read (room for all of it taken up front), then read and shared.
enum Fill { Reading(Vec<u8>), Done(Arc<Vec<u8>>) }

/// Refused by `begin`: the page says where large files go (once, beside the list), so this names only the file's problem.
const NO_MEMORY: &str = "This browser cannot hold this file in memory.";
/// Memory `begin` keeps free beyond the file itself: a sender's own allocations (a chunk, the file list, the frame
/// buffers, a refit's second sender) stay far below it.
const HEADROOM: usize = 128 << 20;
const CHANGED: &str = "This file changed while it was read. Remove it and add it again.";
const NOT_READING: &str = "This file is not being read.";

#[wasm_bindgen]
impl WebFiles {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WebFiles { WebFiles { files: BTreeMap::new(), next: 1 } }
    /// Room for a file of `size` bytes named `name`, taken now; its id. Refused when this tab cannot have that much.
    pub fn begin(&mut self, name: &str, size: f64) -> Result<u32, JsValue> {
        if !(size >= 0.0) || size > isize::MAX as f64 { return Err(JsValue::from_str(NO_MEMORY)); }
        let size = size as usize;
        let mut v = Vec::new();
        v.try_reserve_exact(size).map_err(|_| JsValue::from_str(NO_MEMORY))?;
        // and room left to send it: making a sender at Start, a refit's second sender and the frames take tens of MiB
        // more, and running out there is a trap that can leave the module broken. The probe is let go at once (the
        // memory it grew stays the module's, free for what follows); every begin checks again
        let mut room: Vec<u8> = Vec::new();
        if room.try_reserve_exact(HEADROOM).is_err() { return Err(JsValue::from_str(NO_MEMORY)); }
        drop(room);
        let id = self.next;
        self.next = self.next.wrapping_add(1).max(1);
        self.files.insert(id, StoredFile { name: name.to_string(), size, data: Fill::Reading(v), hash: Hash::Running(Box::default()) });
        Ok(id)
    }
    /// The next bytes of file `id`, in order. Refused past the size it was begun with (the file changed while read).
    pub fn append(&mut self, id: u32, bytes: &[u8]) -> Result<(), JsValue> {
        match self.files.get_mut(&id) {
            Some(StoredFile { size, data: Fill::Reading(v), hash, .. }) if v.len() + bytes.len() <= *size => {
                v.extend_from_slice(bytes);
                if let Hash::Running(h) = hash { h.update(bytes); }
                Ok(())
            }
            Some(StoredFile { data: Fill::Reading(_), .. }) => Err(JsValue::from_str(CHANGED)),
            _ => Err(JsValue::from_str(NOT_READING)),
        }
    }
    /// File `id` is read: from now on it can be sent. Refused when fewer bytes came than its size.
    pub fn finish(&mut self, id: u32) -> Result<(), JsValue> {
        let f = self.files.get_mut(&id).ok_or_else(|| JsValue::from_str(NOT_READING))?;
        match &mut f.data {
            Fill::Reading(v) if v.len() == f.size => {
                let v = std::mem::take(v);
                f.data = Fill::Done(Arc::new(v));
                if let Hash::Running(h) = std::mem::replace(&mut f.hash, Hash::Running(Box::default())) { f.hash = Hash::Done(h.finish()); }
                Ok(())
            }
            Fill::Reading(_) => Err(JsValue::from_str(CHANGED)),
            Fill::Done(_) => Ok(()),
        }
    }
    /// File `id`'s SHA-256 as 64 lower-case hex digits once it is read whole (what the receiver verifies a single file
    /// against); empty while it is read or for an id not held.
    pub fn sha256(&self, id: u32) -> String {
        match self.files.get(&id) { Some(StoredFile { hash: Hash::Done(h), .. }) => lensbolt_core::flat::live::hex(&h.file), _ => String::new() }
    }
    /// Lets file `id` go: its memory is free once no sender holds it.
    pub fn remove(&mut self, id: u32) { self.files.remove(&id); }
    /// Files held (read or being read).
    pub fn count(&self) -> u32 { self.files.len() as u32 }
    /// Bytes held for them (room taken for a file being read included).
    pub fn bytes_held(&self) -> f64 { self.files.values().map(|f| match &f.data { Fill::Reading(v) => v.capacity(), Fill::Done(d) => d.len() }).sum::<usize>() as f64 }
}

impl Default for WebFiles { fn default() -> Self { Self::new() } }

const NOTHING_NAMED: &str = "These words name nothing to send. Check them on the phone.";

/// Finish words (or any list words that cannot be a calibration code) typed where calibration words go.
const FINISH_NOT_CALIBRATION: &str = "These are not calibration words. Finish words go in Finish words.";

/// One to three words starting with a word of the list's last quarter: never finish words (a code starting there is
/// a window code, always four words), and never sent to the calibration field either: they may be the start of four
/// finish words, whose first two pass the calibration check 1 time in 1,024. Calibration words (always two words, the
/// first from the last quarter) typed here are such words too, so the refusal also says where those go.
const TYPE_ALL_FOUR: &str = "The phone shows four words: type all four (calibration words go under Advanced).";
fn starts_a_window_code(code: &str) -> bool {
    let typed = typed_words(code);
    (1..=3).contains(&typed.len()) && word_index(typed[0]).is_ok_and(|i| i as usize >= CALIB_FIRST)
}

/// A refused code in plain words: what is wrong and what to do.
fn finish_error(code: &str, e: FinishError) -> String {
    if starts_a_window_code(code) { return TYPE_ALL_FOUR.into(); }
    match e {
        FinishError::Empty => "Type the words the phone shows.".into(),
        FinishError::Word(WordError::Unknown(w)) => format!("\u{201c}{w}\u{201d} is not one of the words. Check it on the phone."),
        FinishError::Word(WordError::Ambiguous(w)) => format!("\u{201c}{w}\u{201d} is close to more than one word. Type it again."),
        FinishError::Malformed if typed_words(code).len() > 4 => "The phone shows at most four words.".into(),
        FinishError::Malformed => "These words do not name parts of this file. Check them on the phone.".into(),
        FinishError::Check => "These words are for another file, or one is mistyped. Check them on the phone.".into(),
    }
}
/// The words of a typed code, as the codec splits them (spaces, dashes or commas between words).
fn typed_words(code: &str) -> Vec<&str> { code.split(|c: char| c.is_whitespace() || c == '-' || c == ',').filter(|w| !w.is_empty()).collect() }

/// The sender's autocomplete for the letters of the word being typed: the whole word, or empty when none may be
/// shown (`words::suggest`: never a word other than the one meant, whatever single mistake was made).
#[wasm_bindgen]
pub fn suggest_word(typed: &str) -> String {
    lensbolt_core::words::suggest(typed).map(|i| WORDS[i as usize].to_string()).unwrap_or_default()
}

/// Finish words checked without the file (before Start): the spelling of each word and how many there are. Gives
/// the words as the matcher reads them, each in full ("rivr, Candle" -> "river candle"), or the refusal in plain
/// words naming the word to type again. What they mean for the file is checked by `WebSender::finish` at Start.
#[wasm_bindgen]
pub fn check_finish_words(code: &str) -> Result<String, JsValue> {
    let typed = typed_words(code);
    if typed.is_empty() { return Err(JsValue::from_str(&finish_error(code, FinishError::Empty))); }
    if starts_a_window_code(code) { return Err(JsValue::from_str(TYPE_ALL_FOUR)); }
    if typed.len() > 4 { return Err(JsValue::from_str(&finish_error(code, FinishError::Malformed))); }
    let read: Result<Vec<&str>, WordError> = typed.into_iter().map(|w| word_index(w).map(|i| WORDS[i as usize])).collect();
    read.map(|v| v.join(" ")).map_err(|e| JsValue::from_str(&finish_error(code, FinishError::Word(e))))
}

/// The file's transfer id and its number of parts, as "id,parts": the same as this file's sender uses (the id is
/// the hash of its manifest). For tests and tools, like `describe_finish` and `finish_code`: the page checks words
/// against the file only through `WebSender::finish`, at Start.
#[wasm_bindgen]
pub fn finish_context(filename: &str, data: Vec<u8>) -> Result<String, JsValue> {
    let p = lensbolt_core::file::Prepared::from_bytes(filename, data).map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(format!("{},{}", lensbolt_core::file::content_transfer_id(&p.manifest), p.manifest.finish_units()))
}

/// `WebSender::finish` without a sender: what the words mean for the file of `finish_context`, or why they are refused.
#[wasm_bindgen]
pub fn describe_finish(transfer_id: u16, parts: u32, code: &str) -> Result<String, JsValue> {
    let units = lensbolt_core::finish::decode(transfer_id, parts, code).map_err(|e| JsValue::from_str(&finish_error(code, e)))?;
    if units.is_empty() { return Err(JsValue::from_str(NOTHING_NAMED)); }
    Ok(parts_text(&units))
}

/// The finish words for `short` (part indices from 0) of the file of `finish_context`, as a receiver would show
/// them; empty when none apply. For tests and tools: the page itself never makes codes.
#[wasm_bindgen]
pub fn finish_code(transfer_id: u16, parts: u32, short: Vec<u32>) -> String {
    lensbolt_core::finish::encode(transfer_id, parts, &short).unwrap_or_default()
}

/// A refused calibration code in plain words. Words on the list that cannot be a calibration code (finish words,
/// say) are named as such: the calibration field never takes finish words. Otherwise one sentence, so the page's
/// alert does not change with every letter typed. One word alone is never called finish words: it may be the first
/// word of calibration words still being typed.
fn code_error(code: &str, e: CodeError) -> String {
    let typed = typed_words(code);
    let finish_like = (3..=4).contains(&typed.len()) && typed.iter().all(|w| word_index(w).is_ok());
    match e {
        CodeError::NotCalibration => FINISH_NOT_CALIBRATION.into(),
        CodeError::WrongShape if finish_like => FINISH_NOT_CALIBRATION.into(),
        CodeError::WrongShape | CodeError::Word(_) | CodeError::Checksum => "Those words are not a LensBolt code. Check the spelling on the phone.".into(),
    }
}

/// Validate two calibration words without building a sender: returns "pitch,alphabet,fps", or the refusal in plain
/// words.
#[wasm_bindgen]
pub fn describe_code(code: &str) -> Result<String, JsValue> {
    let c = Config::from_code(code).map_err(|e| JsValue::from_str(&code_error(code, e)))?;
    Ok(format!("{},{},{}", c.pitch, c.alphabet.name(), c.fps_value()))
}

/// Two Tune words as the sender's speed choice names them (`calib::mode_words`): "Fast", "Reliable, 20 fps (3
/// refreshes per frame)", "4 px · 8 colours, 60 fps"; refusals in plain words, as `describe_code`.
#[wasm_bindgen]
pub fn describe_mode(code: &str) -> Result<String, JsValue> {
    let c = Config::from_code(code).map_err(|e| JsValue::from_str(&code_error(code, e)))?;
    Ok(lensbolt_core::calib::mode_words(&c))
}

/// Bytes per second a configuration carries in a `width` x `height` tile at 100% yield, for the ETA
/// shown before sending (manifest frames excluded).
#[wasm_bindgen]
pub fn bytes_per_second(width: u32, height: u32, code: &str) -> f64 {
    let (format, fps) = match Config::from_code(code) { Ok(c) => (c.format(), c.fps_value() as f64), Err(_) => (DEFAULT_FORMAT, 30.0) };
    let Some(g) = FlatGrid::try_new(width, height, format) else { return 0.0 };
    if FlatGrid::try_new(width, height, MANIFEST_FORMAT).is_none() { return 0.0; }
    let m = MANIFEST_EVERY as f64;
    fps * (m - 1.0) / m * (g.packets() * lensbolt_core::packet::PACKET_BYTES) as f64
}

/// The tile to draw on a screen of `sw` x `sh` physical px, as "width,height": 1024 wide (the receiver's
/// standard; screens narrower than that cannot send) and the tallest of 1024/896/768/640 that fits.
#[wasm_bindgen]
pub fn tile_for_screen(sw: u32, sh: u32) -> String {
    if sw < 1024 { return "0,0".to_string(); }
    let h = [1024u32, 896, 768, 640].into_iter().find(|&h| h <= sh).unwrap_or(0);
    format!("1024,{h}")
}

/// Browser receiver: the page (in a worker) hands camera frames, RGBA as `getImageData` gives them, to
/// `push`; each call returns the status JSON. When `complete` is true, `take_file` gives the verified file
/// once and `file_name` its (sanitised) name. Nothing leaves the page.
#[wasm_bindgen]
pub struct WebReceiver { session: lensbolt_core::flat::session::RxSession, name: Option<String>, arena: Option<Arc<Mutex<Arena>>> }

#[wasm_bindgen]
impl WebReceiver {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WebReceiver { WebReceiver { session: lensbolt_core::flat::session::RxSession::new(), name: None, arena: None } }
    /// One frame; `now_ms` from `performance.now()`.
    pub fn push(&mut self, rgba: &[u8], width: u32, height: u32, now_ms: f64) -> String { self.session.push_rgba_at(rgba, width, height, now_ms) }
    /// One camera frame as I420 planes straight from `VideoFrame.copyTo` (no RGBA readback): `layout` is the
    /// offset and stride of the Y, U and V planes, in that order, as `copyTo` returns them.
    pub fn push_i420(&mut self, buf: &[u8], width: u32, height: u32, layout: &[u32], now_ms: f64) -> String {
        let mut l = [0usize; 6];
        for (d, s) in l.iter_mut().zip(layout) { *d = *s as usize; }
        if layout.len() < 6 { l = [usize::MAX; 6]; }
        self.session.push_i420_at(buf, width, height, l, now_ms)
    }
    /// A `WebReader`'s record of one frame (read in another worker) taken at `now_ms`: the status `push_i420`
    /// gives for that frame. Records may come out of order; one older than the newest so far adds its packets and
    /// counts, and leaves the last frame's fields to the newer one.
    pub fn push_read(&mut self, record: &[u8], now_ms: f64) -> String { self.session.push_read(record, now_ms) }
    pub fn is_complete(&self) -> bool { self.session.is_complete() }
    /// Starts Tune at `now_ms`: from the next frame on, the sender's Tune carousel is measured (not received), and the
    /// status's "tune" says where it stands (`{"state","progress","failure","result"}`). `high_speed_60`: a capture
    /// path that really delivers 60 fps (the browser has none: false).
    pub fn start_tune(&mut self, high_speed_60: bool, now_ms: f64) { self.session.start_tune(lensbolt_core::tune::TuneOptions { high_speed_60 }, now_ms); }
    /// Back to receiving (the status's "tune" null).
    pub fn stop_tune(&mut self) { self.session.stop_tune(); }
    /// The verified file's bytes, once (empty afterwards).
    pub fn take_file(&mut self) -> Vec<u8> {
        match self.session.take_file() { Some((name, data)) => { self.name = Some(name); data } None => Vec::new() }
    }
    pub fn file_name(&self) -> String { self.name.clone().unwrap_or_default() }
    /// Files `offset .. offset + count` (at most 1,000) of the batch being received, as JSON: `{"offset","total",
    /// "files":[{"name","size","state"}]}` (`state` "waiting", "receiving" with "progress", "received", or "failed"
    /// with "reason"). The status carries only the batch's counts (its "batch" object); the list is read a page at a
    /// time, when it is shown.
    pub fn batch_page(&self, offset: u32, count: u32) -> String { self.session.batch_page(offset, count) }
    /// An in-memory receiver's batch files saved since the last call, each once: an array of `[index, name, bytes]`
    /// (index in the batch's list). Walks the list: call it when the status's received count grows.
    pub fn take_received_files(&mut self) -> js_sys::Array {
        let out = js_sys::Array::new();
        let files = self.session.batch_files(0, usize::MAX);
        for (i, f) in files.iter().enumerate() {
            if f.state != lensbolt_core::file::FileStage::Received { continue; }
            if let Some((name, data)) = self.session.take_batch_file(i) {
                let row = js_sys::Array::new();
                row.push(&JsValue::from(i as u32)); row.push(&JsValue::from_str(&name)); row.push(&js_sys::Uint8Array::from(&data[..]));
                out.push(&row);
            }
        }
        out
    }
}

impl Default for WebReceiver { fn default() -> Self { Self::new() } }

/// A frame reader for a worker of its own: camera frames in, one compact record per frame out, for the collector's
/// `WebReceiver::push_read`. It tracks the frames it reads (each read's geometry is the next one's hint) and can take
/// another reader's geometry (`hint`, `set_hint`) when that is fresher. Holds no file state.
#[wasm_bindgen]
pub struct WebReader { reader: lensbolt_core::flat::session::FrameReader, ok: bool }

#[wasm_bindgen]
impl WebReader {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WebReader { WebReader { reader: lensbolt_core::flat::session::FrameReader::new(), ok: false } }
    /// One camera frame as I420 planes (`WebReceiver::push_i420`'s layout): its record (the header, the frames' cells
    /// as the receiver takes them, the per-frame diagnostics; for a frame with no tile, why).
    pub fn read_i420(&mut self, buf: &[u8], width: u32, height: u32, layout: &[u32]) -> Vec<u8> {
        let mut l = [0usize; 6];
        for (d, s) in l.iter_mut().zip(layout) { *d = *s as usize; }
        if layout.len() < 6 { l = [usize::MAX; 6]; }
        self.record(|r| r.read_i420(buf, width, height, l))
    }
    /// One camera frame, RGBA as `getImageData` gives it: its record.
    pub fn read_rgba(&mut self, rgba: &[u8], width: u32, height: u32) -> Vec<u8> { self.record(|r| r.read_rgba(rgba, width, height)) }
    fn record(&mut self, f: impl FnOnce(&mut lensbolt_core::flat::session::FrameReader) -> lensbolt_core::flat::session::FrameRead) -> Vec<u8> {
        let read = f(&mut self.reader);
        self.ok = matches!(read, lensbolt_core::flat::session::FrameRead::Read { .. });
        read.to_bytes()
    }
    /// Whether the last frame read showed a tile (its geometry is then this reader's `hint`).
    pub fn last_ok(&self) -> bool { self.ok }
    /// The geometry this reader tracks, for another reader's `set_hint`; empty before its first read.
    pub fn hint(&self) -> Vec<u8> { self.reader.hint_bytes() }
    /// Another reader's geometry as the hint for this reader's next frame; false for bytes that are not a hint.
    pub fn set_hint(&mut self, bytes: &[u8]) -> bool { self.reader.set_hint(bytes) }
    /// Forget the tracked geometry (the collector's status counted a re-anchor): the next frame is identified from scratch.
    pub fn clear_hint(&mut self) { self.reader.clear_hint() }
}

impl Default for WebReader { fn default() -> Self { Self::new() } }

/// `s` as a JSON string.
fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c { '"' => o.push_str("\\\""), '\\' => o.push_str("\\\\"), c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)), c => o.push(c) }
    }
    o.push('"');
    o
}

// Origin Private File System stores, provided by the worker as `self.lbStore` (two pre-opened sync access
// handles: slot 0 the reassembled stream, slot 1 a compressed transfer's file). Large files never sit in memory.
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(catch, js_namespace = lbStore, js_name = write)]
    fn store_write(slot: u32, offset: f64, data: &[u8]) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_namespace = lbStore, js_name = read)]
    fn store_read(slot: u32, offset: f64, buf: &mut [u8]) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_namespace = lbStore, js_name = truncate)]
    fn store_truncate(slot: u32, len: f64) -> Result<(), JsValue>;
}
/// A store error as the receiver reads it: a browser's QuotaExceededError keeps its kind (the receiver says "storage
/// full"), any other error its message.
fn js_err(e: JsValue) -> std::io::Error {
    let prop = |k: &str| js_sys::Reflect::get(&e, &JsValue::from_str(k)).ok().and_then(|v| v.as_string());
    let msg = e.as_string().or_else(|| prop("message")).unwrap_or_else(|| "storage error".into());
    if prop("name").as_deref() == Some("QuotaExceededError") { return std::io::Error::new(std::io::ErrorKind::QuotaExceeded, format!("storage full ({msg})")); }
    std::io::Error::other(msg)
}

/// A batch's files, written one after another into store slot 1 (the arena): each file a region starting where the
/// last one ended. The worker copies each finished region into an OPFS file of its own between frames
/// (`WebReceiver::take_regions`), and the arena then starts again from 0, so it holds at most the files saved during
/// one frame. A single compressed file is the arena's only region, at 0: slot 1 is that file, as before.
#[derive(Default)]
struct Arena { end: u64, regions: Vec<Region> }
struct Region { name: String, at: u64, len: u64, done: bool, gone: bool, taken: bool }
impl Arena {
    /// Where the next region starts: after every byte written so far.
    fn next_at(&self) -> u64 { self.regions.iter().filter(|r| !r.gone).map(|r| r.at + r.len).fold(self.end, u64::max) }
}

struct JsStore { slot: u32, base: u64, region: Option<(Arc<Mutex<Arena>>, usize)> }
impl lensbolt_core::file::PartStore for JsStore {
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> std::io::Result<()> { store_read(self.slot, (self.base + offset) as f64, buf).map_err(js_err) }
    fn write_at(&mut self, offset: u64, data: &[u8]) -> std::io::Result<()> {
        store_write(self.slot, (self.base + offset) as f64, data).map_err(js_err)?;
        if let Some((arena, i)) = &self.region { let mut a = arena.lock().unwrap(); let r = &mut a.regions[*i]; r.len = r.len.max(offset + data.len() as u64); }
        Ok(())
    }
    fn set_len(&mut self, len: u64) -> std::io::Result<()> {
        let Some((arena, i)) = &self.region else { return store_truncate(self.slot, len as f64).map_err(js_err) };
        let mut a = arena.lock().unwrap();
        { let r = &mut a.regions[*i]; r.len = len; r.done = true; }
        a.end = a.next_at();
        store_truncate(1, a.end as f64).map_err(js_err)
    }
}
struct JsStores { arena: Arc<Mutex<Arena>> }
impl lensbolt_core::file::StoreFactory for JsStores {
    fn create(&mut self, name: &str) -> std::io::Result<Box<dyn lensbolt_core::file::PartStore>> {
        // the reassembled stream: slot 0, from its start
        if name.ends_with(".lbpart") {
            store_truncate(0, 0.0).map_err(js_err)?;
            return Ok(Box::new(JsStore { slot: 0, base: 0, region: None }));
        }
        let mut a = self.arena.lock().unwrap();
        let at = a.next_at();
        if at == 0 { store_truncate(1, 0.0).map_err(js_err)?; }
        a.regions.push(Region { name: name.to_string(), at, len: 0, done: false, gone: false, taken: false });
        let i = a.regions.len() - 1;
        Ok(Box::new(JsStore { slot: 1, base: at, region: Some((self.arena.clone(), i)) }))
    }
    fn remove(&mut self, name: &str) {
        if name.ends_with(".lbpart") { let _ = store_truncate(0, 0.0); return; }
        let mut a = self.arena.lock().unwrap();
        if let Some(r) = a.regions.iter_mut().rev().find(|r| r.name == name && !r.gone) { r.gone = true; }
        // the space of a region at the end is given back
        let end = a.regions.iter().filter(|r| !r.gone).map(|r| r.at + r.len).max().unwrap_or(0);
        a.end = end;
        let _ = store_truncate(1, end as f64);
    }
}

#[wasm_bindgen]
impl WebReceiver {
    /// A receiver writing into the worker's OPFS stores (`self.lbStore`) instead of memory.
    pub fn with_opfs() -> WebReceiver {
        let arena = Arc::new(Mutex::new(Arena::default()));
        WebReceiver { session: lensbolt_core::flat::session::RxSession::with_stores(Box::new(JsStores { arena: arena.clone() })), name: None, arena: Some(arena) }
    }
    /// A store-backed batch's files saved since the last call, as JSON `[{"name","at","size"}]`: each file's bytes are
    /// `at .. at + size` of store slot 1, kept there (later files go after them) until `release_region(name)`.
    pub fn take_regions(&mut self) -> String {
        let Some(arena) = &self.arena else { return "[]".into() };
        let mut a = arena.lock().unwrap();
        let mut out = Vec::new();
        for r in a.regions.iter_mut().filter(|r| r.done && !r.gone && !r.taken) {
            r.taken = true;
            out.push(format!("{{\"name\":{},\"at\":{},\"size\":{}}}", json_str(&r.name), r.at, r.len));
        }
        format!("[{}]", out.join(","))
    }
    /// File `name` (from `take_regions`) is copied out: its bytes in slot 1 may be written over. Once every file
    /// written so far is released, slot 1 starts again from 0 and is truncated (the copies take no space twice).
    pub fn release_region(&mut self, name: &str) {
        let Some(arena) = &self.arena else { return };
        let mut a = arena.lock().unwrap();
        if let Some(r) = a.regions.iter_mut().find(|r| r.name == name && r.taken && !r.gone) { r.gone = true; }
        // every file written so far copied out: the arena starts again from 0, its space given back to the device
        if a.regions.iter().all(|r| r.gone) { a.regions.clear(); a.end = 0; let _ = store_truncate(1, 0.0); }
    }
    /// Slot of the store holding the verified file (0 stream, 1 decompressed file), or -1.
    pub fn stored_slot(&self) -> i32 { match self.session.stored_file() { Some((_, store)) => if store.ends_with(".lbpart") { 0 } else { 1 }, None => -1 } }
    /// The verified file's shown name.
    pub fn stored_name(&self) -> String { self.session.stored_file().map(|(n, _)| n).unwrap_or_default() }
}
