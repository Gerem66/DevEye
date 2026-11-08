//! Windows and macOS backend: `tray-icon`, driven by a hand-written event loop
//! on the main thread (a Win32 message loop, an `NSApplication` event pump).

use anyhow::{Context, Result};
use tracing::warn;
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

use super::icon::{self, Look};
use super::view::{self, TrayView};
use super::{Action, Controller, Step, TICK};

struct Ui {
    tray: TrayIcon,
    items: Items,
    labels: view::Labels,
    size: u32,
}

/// The menu and its entries, built again when the view gains or loses lines
/// (an agent of another instance starts or stops).
struct Items {
    menu: Menu,
    lines: Vec<MenuItem>,
    activity: Option<MenuItem>,
    opens: Vec<MenuItem>,
    hide: MenuItem,
    quit: MenuItem,
}

impl Items {
    fn build(view: &TrayView, labels: &view::Labels) -> Result<Self> {
        let info = |text: &str| MenuItem::new(text, false, None);
        let items = Items {
            menu: Menu::new(),
            lines: view.lines.iter().map(|l| info(l)).collect(),
            activity: view.activity.as_deref().map(info),
            opens: view
                .opens
                .iter()
                .map(|(label, _)| MenuItem::new(label, true, None))
                .collect(),
            hide: MenuItem::new(labels.hide, true, None),
            quit: MenuItem::new(labels.quit, true, None),
        };
        for line in items.lines.iter().chain(&items.activity) {
            items.menu.append(line).context("building the menu")?;
        }
        items
            .menu
            .append(&PredefinedMenuItem::separator())
            .context("building the menu")?;
        for open in &items.opens {
            items.menu.append(open).context("building the menu")?;
        }
        items
            .menu
            .append_items(&[&items.hide, &PredefinedMenuItem::separator(), &items.quit])
            .context("building the menu")?;
        Ok(items)
    }

    /// The view has as many entries of each kind as this menu.
    fn fits(&self, view: &TrayView) -> bool {
        self.lines.len() == view.lines.len()
            && self.activity.is_some() == view.activity.is_some()
            && self.opens.len() == view.opens.len()
    }

    fn set_texts(&self, view: &TrayView) {
        for (item, text) in self.lines.iter().zip(&view.lines) {
            item.set_text(text);
        }
        if let (Some(item), Some(text)) = (&self.activity, &view.activity) {
            item.set_text(text);
        }
        for (item, (label, _)) in self.opens.iter().zip(&view.opens) {
            item.set_text(label);
        }
    }
}

impl Ui {
    fn new(controller: &Controller) -> Result<Self> {
        let labels = view::labels(controller.lang());
        let view = controller.view();
        let items = Items::build(view, &labels)?;
        let size = platform::icon_size();
        let builder = TrayIconBuilder::new()
            .with_id("deveye-agent")
            .with_menu(Box::new(items.menu.clone()))
            .with_tooltip(view.tooltip())
            .with_icon(render(size, controller.look())?);
        // Windows habit: a left click acts, the right one shows the menu. On
        // macOS every click shows the menu.
        #[cfg(windows)]
        let builder = builder.with_menu_on_left_click(false);
        let tray = builder.build().context("creating the tray icon")?;
        Ok(Ui {
            tray,
            items,
            labels,
            size,
        })
    }

    fn show_view(&mut self, view: &TrayView) {
        if self.items.fits(view) {
            self.items.set_texts(view);
        } else {
            match Items::build(view, &self.labels) {
                Ok(items) => {
                    self.tray.set_menu(Some(Box::new(items.menu.clone())));
                    self.items = items;
                }
                Err(e) => warn!(error = %e, "cannot rebuild the menu"),
            }
        }
        let _ = self.tray.set_tooltip(Some(view.tooltip()));
    }

    fn show_look(&self, look: Look) {
        match render(self.size, look) {
            Ok(icon) => {
                let _ = self.tray.set_icon(Some(icon));
            }
            Err(e) => warn!(error = %e, "cannot draw the icon"),
        }
    }

    /// Menu choices and clicks since the last call.
    fn actions(&self) -> Vec<Action> {
        let mut actions = Vec::new();
        while let Ok(event) = MenuEvent::receiver().try_recv() {
            if let Some(index) = self.items.opens.iter().position(|o| event.id == *o.id()) {
                actions.push(Action::Open(index));
            } else if event.id == *self.items.hide.id() {
                actions.push(Action::Hide);
            } else if event.id == *self.items.quit.id() {
                actions.push(Action::Quit);
            }
        }
        while let Ok(event) = TrayIconEvent::receiver().try_recv() {
            if cfg!(windows)
                && matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                )
            {
                actions.push(Action::Open(0));
            }
        }
        actions
    }

    /// Apply a step; `false` once the tray must end.
    fn apply(&mut self, controller: &Controller, step: Step) -> bool {
        if let Some((summary, body)) = step.notice {
            platform::notify(summary, body);
        }
        if step.exit {
            return false;
        }
        if step.menu {
            self.show_view(controller.view());
        }
        if step.icon {
            self.show_look(controller.look());
        }
        true
    }

    /// Handle pending actions, then a tick when one is due; `false` to end.
    fn pump(&mut self, controller: &mut Controller, tick_due: bool) -> bool {
        for action in self.actions() {
            let step = controller.act(action);
            if !self.apply(controller, step) {
                return false;
            }
        }
        if tick_due {
            let step = controller.tick();
            return self.apply(controller, step);
        }
        true
    }
}

fn render(size: u32, look: Look) -> Result<Icon> {
    Icon::from_rgba(icon::render(size, look), size, size).context("building the icon image")
}

pub fn run(mut controller: Controller) -> Result<()> {
    platform::init()?;
    let mut ui = Ui::new(&controller)?;
    platform::event_loop(|tick_due| ui.pump(&mut controller, tick_due));
    Ok(())
}

#[cfg(windows)]
mod platform {
    use std::ptr::null_mut;

    use windows_sys::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, GetSystemMetrics, MessageBoxW, SetTimer, TranslateMessage,
        MB_ICONINFORMATION, MB_OK, MSG, SM_CXSMICON, WM_TIMER,
    };

    use super::*;

    pub fn init() -> Result<()> {
        // Without it, Windows scales a 16 px icon up on high-DPI screens.
        // SAFETY: a process-wide setting, made before any window exists.
        unsafe {
            SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        Ok(())
    }

    pub fn icon_size() -> u32 {
        // SAFETY: a metric query, no preconditions.
        let size = unsafe { GetSystemMetrics(SM_CXSMICON) };
        u32::try_from(size).ok().filter(|&s| s >= 16).unwrap_or(16)
    }

    pub fn notify(summary: &str, body: &str) {
        let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let (title, text) = (wide(summary), wide(body));
        // SAFETY: both strings are NUL-terminated and outlive the modal call.
        unsafe {
            MessageBoxW(
                null_mut(),
                text.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONINFORMATION,
            );
        }
    }

    /// A thread timer paces the ticks; `tray-icon` gets its window messages
    /// from the same loop.
    pub fn event_loop(mut pump: impl FnMut(bool) -> bool) {
        // SAFETY: a thread timer (no window, no callback): it posts WM_TIMER
        // to this thread's queue, read below.
        unsafe {
            SetTimer(null_mut(), 0, TICK.as_millis() as u32, None);
        }
        // SAFETY: `MSG` is plain data, filled by `GetMessageW` before any read.
        let mut msg: MSG = unsafe { std::mem::zeroed() };
        loop {
            // SAFETY: `msg` is a valid out-pointer; 0 means WM_QUIT, -1 an error.
            let got = unsafe { GetMessageW(&mut msg, null_mut(), 0, 0) };
            if got <= 0 {
                return;
            }
            // SAFETY: `msg` was just filled by `GetMessageW`.
            unsafe {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if !pump(msg.message == WM_TIMER && msg.hwnd.is_null()) {
                return;
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::time::Instant;

    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy, NSEventMask};
    use objc2_foundation::{NSDate, NSDefaultRunLoopMode};

    use super::*;

    fn app() -> Result<objc2::rc::Retained<NSApplication>> {
        let mtm = MainThreadMarker::new().context("the icon must run on the main thread")?;
        Ok(NSApplication::sharedApplication(mtm))
    }

    /// An accessory app: an icon in the menu bar, none in the Dock.
    pub fn init() -> Result<()> {
        let app = app()?;
        app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
        app.finishLaunching();
        Ok(())
    }

    /// Rendered at twice the menu bar's 18 pt, for Retina screens.
    pub fn icon_size() -> u32 {
        36
    }

    fn applescript_string(s: &str) -> String {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    }

    pub fn notify(summary: &str, body: &str) {
        let script = format!(
            "display notification {} with title {}",
            applescript_string(body),
            applescript_string(summary)
        );
        let _ = std::process::Command::new("osascript")
            .args(["-e", &script])
            .status();
    }

    /// Pumps AppKit events, waking at least every [`TICK`] for the animation.
    /// While the menu is open AppKit runs its own loop, and the eye pauses.
    pub fn event_loop(mut pump: impl FnMut(bool) -> bool) {
        let Ok(app) = app() else {
            return;
        };
        let mut next_tick = Instant::now() + TICK;
        loop {
            let wait = next_tick.saturating_duration_since(Instant::now());
            let until = NSDate::dateWithTimeIntervalSinceNow(wait.as_secs_f64());
            // SAFETY: a constant string exported by Foundation.
            let mode = unsafe { NSDefaultRunLoopMode };
            if let Some(event) = app.nextEventMatchingMask_untilDate_inMode_dequeue(
                NSEventMask::Any,
                Some(&until),
                mode,
                true,
            ) {
                app.sendEvent(&event);
            }
            let tick_due = Instant::now() >= next_tick;
            if tick_due {
                next_tick = Instant::now() + TICK;
            }
            if !pump(tick_due) {
                return;
            }
        }
    }
}
