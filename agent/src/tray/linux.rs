//! Linux backend: a StatusNotifierItem on the session bus (KDE, and GNOME with
//! the AppIndicator extension, most other panels natively).

use std::collections::HashMap;

use anyhow::{Context, Result};
use ksni::menu::StandardItem;
use ksni::{Category, MenuItem, ToolTip, TrayMethods};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tracing::warn;

use super::icon::{self, Look, FRAMES};
use super::view::{self, Labels, TrayView};
use super::{Action, Controller, TICK};

/// Panels pick the size closest to theirs.
const SIZES: [u32; 4] = [22, 32, 48, 64];

struct Sni {
    view: TrayView,
    look: Look,
    labels: Labels,
    icons: HashMap<Look, Vec<ksni::Icon>>,
    actions: UnboundedSender<Action>,
}

/// Every look the eye can take, rendered once at every size, as the ARGB32
/// (big-endian) pixmaps the protocol carries.
fn render_all() -> HashMap<Look, Vec<ksni::Icon>> {
    let looks = [Look::Idle, Look::Off]
        .into_iter()
        .chain((0..FRAMES).map(Look::Busy));
    looks
        .map(|look| {
            let pixmaps = SIZES
                .iter()
                .map(|&size| {
                    let rgba = icon::render(size, look);
                    let data = rgba
                        .as_chunks::<4>()
                        .0
                        .iter()
                        .flat_map(|&[r, g, b, a]| [a, r, g, b])
                        .collect();
                    ksni::Icon {
                        width: size as i32,
                        height: size as i32,
                        data,
                    }
                })
                .collect();
            (look, pixmaps)
        })
        .collect()
}

/// A menu label is parsed for `_` mnemonics.
fn label(text: &str) -> String {
    text.replace('_', "__")
}

/// The tooltip body accepts a subset of HTML.
fn markup_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

impl ksni::Tray for Sni {
    fn id(&self) -> String {
        "deveye-agent".into()
    }

    fn title(&self) -> String {
        "DevEye".into()
    }

    fn category(&self) -> Category {
        Category::ApplicationStatus
    }

    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        self.icons.get(&self.look).cloned().unwrap_or_default()
    }

    fn tool_tip(&self) -> ToolTip {
        let mut description = markup_escape(&self.view.status);
        if let Some(activity) = &self.view.activity {
            description.push('\n');
            description.push_str(&markup_escape(activity));
        }
        ToolTip {
            title: "DevEye".into(),
            description,
            icon_name: String::new(),
            icon_pixmap: Vec::new(),
        }
    }

    fn activate(&mut self, _x: i32, _y: i32) {
        let _ = self.actions.send(Action::Open);
    }

    fn menu(&self) -> Vec<MenuItem<Self>> {
        let info = |text: &str| -> MenuItem<Self> {
            StandardItem {
                label: label(text),
                enabled: false,
                ..Default::default()
            }
            .into()
        };
        let entry = |text: &str, action: Action| -> MenuItem<Self> {
            StandardItem {
                label: label(text),
                activate: Box::new(move |tray: &mut Self| {
                    let _ = tray.actions.send(action);
                }),
                ..Default::default()
            }
            .into()
        };
        let mut items = vec![info(&self.view.status)];
        if let Some(activity) = &self.view.activity {
            items.push(info(activity));
        }
        items.extend([
            MenuItem::Separator,
            entry(self.labels.open, Action::Open),
            entry(self.labels.hide, Action::Hide),
            MenuItem::Separator,
            entry(self.labels.quit, Action::Quit),
        ]);
        items
    }

    fn watcher_offline(&self, reason: ksni::OfflineReason) -> bool {
        // Keep waiting: the panel may come back (restarted shell, late login).
        warn!(?reason, "no notification area to show the DevEye icon in");
        true
    }
}

pub fn run(mut controller: Controller) -> Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("starting the tray runtime")?;
    runtime.block_on(async move {
        let (tx, mut rx) = unbounded_channel();
        let tray = Sni {
            view: controller.view().clone(),
            look: controller.look(),
            labels: view::labels(controller.lang()),
            icons: render_all(),
            actions: tx,
        };
        // Started at login, the panel may not be up yet: wait for it.
        let handle = tray
            .assume_sni_available(true)
            .spawn()
            .await
            .context("registering the DevEye icon on the session bus")?;
        let mut ticker = tokio::time::interval(TICK);
        loop {
            let step = tokio::select! {
                _ = ticker.tick() => controller.tick(),
                Some(action) = rx.recv() => controller.act(action),
            };
            if let Some((summary, body)) = step.notice {
                if let Err(e) = notify(summary, body).await {
                    warn!(error = %e, "cannot show the desktop notification");
                }
            }
            if step.exit {
                handle.shutdown().await;
                return Ok(());
            }
            if step.menu || step.icon {
                let view = controller.view().clone();
                let look = controller.look();
                let alive = handle
                    .update(move |tray: &mut Sni| {
                        tray.view = view;
                        tray.look = look;
                    })
                    .await;
                if alive.is_none() {
                    return Ok(());
                }
            }
        }
    })
}

/// A desktop notification (`org.freedesktop.Notifications`).
async fn notify(summary: &str, body: &str) -> Result<()> {
    let connection = zbus::Connection::session().await?;
    let hints: HashMap<&str, zbus::zvariant::Value<'_>> = HashMap::new();
    connection
        .call_method(
            Some("org.freedesktop.Notifications"),
            "/org/freedesktop/Notifications",
            Some("org.freedesktop.Notifications"),
            "Notify",
            &(
                "DevEye",
                0u32,
                "",
                summary,
                body,
                Vec::<&str>::new(),
                hints,
                -1i32,
            ),
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_look_is_rendered_at_every_size_in_argb() {
        let icons = render_all();
        assert_eq!(icons.len(), FRAMES + 2);
        let idle = &icons[&Look::Idle];
        assert_eq!(idle.len(), SIZES.len());
        let small = &idle[0];
        assert_eq!(small.data.len(), (small.width * small.height * 4) as usize);
        // The center pixel: opaque, pupil grey, alpha first.
        let center = ((small.height / 2 * small.width + small.width / 2) * 4) as usize;
        assert_eq!(&small.data[center..center + 4], &[255, 55, 55, 57]);
    }

    #[test]
    fn labels_keep_their_underscores() {
        assert_eq!(label("my_host"), "my__host");
    }
}
