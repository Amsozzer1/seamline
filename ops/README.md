# Keep-alive (OptiPlex)

Render's free tier stops an idle instance after 15 minutes. A systemd user timer on an
always-on Linux box pings `/api/ping` every 10 minutes so the demo link loads instantly.

```sh
mkdir -p ~/.config/systemd/user
cp seamline-keepalive.service seamline-keepalive.timer ~/.config/systemd/user/
# edit SEAMLINE_URL in the .service file to the deployed URL
systemctl --user daemon-reload
systemctl --user enable --now seamline-keepalive.timer
loginctl enable-linger "$USER"   # keep user timers running without a login session
systemctl --user list-timers | grep seamline
```
