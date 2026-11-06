using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace TalkityDesktop
{
    /// <summary>Visual state of the dictation HUD.</summary>
    internal enum HudState
    {
        Idle,
        Listening,
        Paused,
        Processing,
        Inserted,
        Error,
        Disconnected
    }

    /// <summary>
    /// Compact always-on-top dictation pill. It owns no dictation logic: it renders
    /// the state the application pushes to it and raises click events back.
    /// Position changes are reported so the application can persist them.
    /// </summary>
    internal sealed class TalkityHud : Form
    {
        private const int WM_NCLBUTTONDOWN = 0xA1;
        private const int HT_CAPTION = 0x2;

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool ReleaseCapture();
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);

        // The HUD is an always-on-top overlay, so it must never become the foreground
        // window. When it did, the window captured at the next hotkey press was the HUD
        // itself, IsOwnWindow() rejected it, and every dictation after that was left on
        // the clipboard instead of being typed into the user's application.
        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= WS_EX_NOACTIVATE;
                return cp;
            }
        }

        private const int WS_EX_NOACTIVATE = 0x08000000;

        private readonly Panel _dot;
        private readonly Label _status;
        private readonly Label _timer;
        private readonly Label _connection;
        private readonly Timer _anim;

        private HudState _state = HudState.Idle;
        private DateTime _startedAt;
        private int _pulse;
        private bool _connected = true;

        public event EventHandler ActionRequested;
        public event EventHandler PositionCommitted;

        public TalkityHud()
        {
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Size = new Size(380, 52);
            TopMost = true;
            ShowInTaskbar = false;
            BackColor = Color.FromArgb(18, 22, 31);
            DoubleBuffered = true;

            _dot = new Panel();
            _dot.Size = new Size(10, 10);
            _dot.Location = new Point(16, 21);
            Controls.Add(_dot);

            _status = new Label();
            _status.Font = new Font("Segoe UI", 10.5f, FontStyle.Bold);
            _status.ForeColor = Color.FromArgb(240, 246, 252);
            _status.Location = new Point(34, 15);
            _status.AutoSize = true;
            Controls.Add(_status);

            _timer = new Label();
            _timer.Font = new Font("Consolas", 9.5f, FontStyle.Regular);
            _timer.ForeColor = Color.FromArgb(139, 148, 158);
            _timer.Location = new Point(250, 17);
            _timer.AutoSize = true;
            _timer.Visible = false;
            Controls.Add(_timer);

            _connection = new Label();
            _connection.Font = new Font("Segoe UI", 7.5f, FontStyle.Regular);
            _connection.ForeColor = Color.FromArgb(139, 148, 158);
            _connection.AutoSize = true;
            _connection.Location = new Point(312, 18);
            _connection.Text = "offline";
            Controls.Add(_connection);

            MouseDown += BeginDrag;
            _status.MouseDown += BeginDrag;
            _status.Click += delegate { if (ActionRequested != null) ActionRequested(this, EventArgs.Empty); };
            Click += delegate { if (ActionRequested != null) ActionRequested(this, EventArgs.Empty); };

            Paint += PaintBorder;

            _anim = new Timer();
            _anim.Interval = 250;
            _anim.Tick += delegate { OnAnimTick(); };
            _anim.Start();

            ApplyState(HudState.Idle, "");
        }

        public void ApplyState(HudState state, string detail)
        {
            if (InvokeRequired) { BeginInvoke(new Action(delegate { ApplyState(state, detail); })); return; }
            _state = state;
            if (state == HudState.Listening && !_timer.Visible)
            {
                _startedAt = DateTime.Now;
                _timer.Text = "00:00";
            }
            _timer.Visible = state == HudState.Listening || state == HudState.Paused;

            switch (state)
            {
                case HudState.Listening:
                    _status.Text = "Listening...";
                    _status.ForeColor = Color.FromArgb(239, 68, 68);
                    break;
                case HudState.Paused:
                    _status.Text = "Paused";
                    _status.ForeColor = Color.FromArgb(234, 179, 8);
                    break;
                case HudState.Processing:
                    _status.Text = "Processing...";
                    _status.ForeColor = Color.FromArgb(0, 242, 254);
                    break;
                case HudState.Inserted:
                    _status.Text = string.IsNullOrEmpty(detail) ? "Inserted" : detail;
                    _status.ForeColor = Color.FromArgb(34, 197, 94);
                    break;
                case HudState.Error:
                    _status.Text = string.IsNullOrEmpty(detail) ? "Something went wrong" : detail;
                    _status.ForeColor = Color.FromArgb(239, 68, 68);
                    break;
                case HudState.Disconnected:
                    _status.Text = "Talkity - offline";
                    _status.ForeColor = Color.FromArgb(139, 148, 158);
                    break;
                default:
                    _status.Text = string.IsNullOrEmpty(detail) ? "Talkity" : detail;
                    _status.ForeColor = Color.FromArgb(240, 246, 252);
                    break;
            }
            Invalidate();
        }

        public void SetConnected(bool connected)
        {
            if (InvokeRequired) { BeginInvoke(new Action(delegate { SetConnected(connected); })); return; }
            _connected = connected;
            _connection.Text = connected ? "online" : "offline";
            _connection.ForeColor = connected ? Color.FromArgb(34, 197, 94) : Color.FromArgb(239, 68, 68);
        }

        public void PlaceAt(int x, int y)
        {
            Rectangle area = Screen.PrimaryScreen.WorkingArea;
            if (x < 0 || y < 0 || x > area.Right || y > area.Bottom)
            {
                Location = new Point((area.Width - Width) / 2, area.Top + 28);
                return;
            }
            Location = new Point(x, y);
        }

        private void OnAnimTick()
        {
            if (_state == HudState.Listening)
            {
                _pulse++;
                _dot.BackColor = (_pulse % 2 == 0) ? Color.FromArgb(239, 68, 68) : Color.FromArgb(120, 20, 20);
                TimeSpan elapsed = DateTime.Now - _startedAt;
                _timer.Text = string.Format("{0:D2}:{1:D2}", (int)elapsed.TotalMinutes, elapsed.Seconds);
                Invalidate();
            }
            else if (_state == HudState.Paused)
            {
                _dot.BackColor = Color.FromArgb(234, 179, 8);
            }
            else if (_state == HudState.Error)
            {
                _dot.BackColor = Color.FromArgb(239, 68, 68);
            }
            else
            {
                _dot.BackColor = _connected ? Color.FromArgb(0, 242, 254) : Color.FromArgb(100, 110, 120);
            }
        }

        private void PaintBorder(object sender, PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle rect = new Rectangle(0, 0, Width - 1, Height - 1);
            using (GraphicsPath path = Rounded(rect, 26))
            {
                Region = new Region(path);
                Color border = Color.FromArgb(0, 242, 254);
                float width = 1.5f;
                if (_state == HudState.Listening) { border = Color.FromArgb(239, 68, 68); width = 2.5f; }
                else if (_state == HudState.Paused) border = Color.FromArgb(234, 179, 8);
                else if (_state == HudState.Error || !_connected) border = Color.FromArgb(239, 68, 68);
                else if (_state == HudState.Inserted) border = Color.FromArgb(34, 197, 94);
                using (Pen pen = new Pen(border, width)) e.Graphics.DrawPath(pen, path);
            }
        }

        private void BeginDrag(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            ReleaseCapture();
            SendMessage(Handle, WM_NCLBUTTONDOWN, HT_CAPTION, 0);
            if (PositionCommitted != null) PositionCommitted(this, EventArgs.Empty);
        }

        private static GraphicsPath Rounded(Rectangle rect, int radius)
        {
            GraphicsPath path = new GraphicsPath();
            int d = radius * 2;
            path.AddArc(rect.X, rect.Y, d, d, 180, 90);
            path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
            path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
            path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // The HUD is never closed on its own; hiding is the application's job.
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
                return;
            }
            _anim.Stop();
            _anim.Dispose();
            base.OnFormClosing(e);
        }
    }
}
