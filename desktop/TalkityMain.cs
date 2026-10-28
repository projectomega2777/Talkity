using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;

namespace TalkityDesktop
{
    /// <summary>
    /// Main window: connection and microphone status, the current transcript,
    /// recent dictation history, and the entry points for settings and dictation.
    /// All dictation behaviour lives in the application shell; this form only
    /// displays state and forwards user actions.
    /// </summary>
    internal sealed class TalkityMainForm : Form
    {
        private readonly Label _connection;
        private readonly Label _mic;
        private readonly Label _state;
        private readonly TextBox _transcript;
        private readonly ListView _history;
        private readonly Button _dictate;
        private readonly Button _copy;
        private readonly Label _hint;

        public event EventHandler DictateRequested;
        public event EventHandler SettingsRequested;
        public event EventHandler ClearHistoryRequested;
        public event EventHandler CopyTranscriptRequested;
        public event EventHandler<HistoryEntry> ReinsertRequested;

        public TalkityMainForm()
        {
            Text = "Talkity";
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(640, 560);
            MinimumSize = new Size(520, 460);
            BackColor = Color.FromArgb(13, 17, 23);
            ForeColor = Color.FromArgb(230, 237, 243);
            Font = new Font("Segoe UI", 9.5f);

            Label title = MakeLabel("Talkity", 18f, FontStyle.Bold, new Point(24, 16));
            Controls.Add(title);
            Controls.Add(MakeLabel("Voice dictation for Windows", 9f, FontStyle.Regular, new Point(26, 48)));

            _connection = MakeLabel("Connection: starting...", 9f, FontStyle.Regular, new Point(26, 80));
            _mic = MakeLabel("Microphone: checking...", 9f, FontStyle.Regular, new Point(26, 100));
            _state = MakeLabel("Idle", 9f, FontStyle.Bold, new Point(26, 120));
            Controls.Add(_connection);
            Controls.Add(_mic);
            Controls.Add(_state);

            _dictate = new Button();
            _dictate.Text = "Start dictation";
            _dictate.Size = new Size(140, 34);
            _dictate.Location = new Point(460, 78);
            _dictate.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            _dictate.FlatStyle = FlatStyle.Flat;
            _dictate.BackColor = Color.FromArgb(0, 150, 170);
            _dictate.ForeColor = Color.White;
            _dictate.FlatAppearance.BorderSize = 0;
            _dictate.Click += delegate { if (DictateRequested != null) DictateRequested(this, EventArgs.Empty); };
            Controls.Add(_dictate);

            _copy = new Button();
            _copy.Text = "Copy text";
            _copy.Size = new Size(100, 28);
            _copy.Location = new Point(500, 140);
            _copy.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            _copy.FlatStyle = FlatStyle.Flat;
            _copy.BackColor = Color.FromArgb(33, 38, 45);
            _copy.ForeColor = Color.FromArgb(230, 237, 243);
            _copy.FlatAppearance.BorderSize = 0;
            _copy.Enabled = false;
            _copy.Click += delegate { if (CopyTranscriptRequested != null) CopyTranscriptRequested(this, EventArgs.Empty); };
            Controls.Add(_copy);

            Button settings = new Button();
            settings.Text = "Settings";
            settings.Size = new Size(90, 28);
            settings.Location = new Point(510, 18);
            settings.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            settings.FlatStyle = FlatStyle.Flat;
            settings.BackColor = Color.FromArgb(33, 38, 45);
            settings.ForeColor = Color.FromArgb(230, 237, 243);
            settings.FlatAppearance.BorderSize = 0;
            settings.Click += delegate { if (SettingsRequested != null) SettingsRequested(this, EventArgs.Empty); };
            Controls.Add(settings);

            Controls.Add(MakeLabel("Last transcript", 8.5f, FontStyle.Bold, new Point(26, 156)));
            _transcript = new TextBox();
            _transcript.Location = new Point(26, 176);
            _transcript.Size = new Size(574, 70);
            _transcript.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            _transcript.Multiline = true;
            _transcript.ReadOnly = true;
            _transcript.ScrollBars = ScrollBars.Vertical;
            _transcript.BackColor = Color.FromArgb(22, 27, 34);
            _transcript.ForeColor = Color.FromArgb(230, 237, 243);
            _transcript.BorderStyle = BorderStyle.FixedSingle;
            Controls.Add(_transcript);

            _hint = MakeLabel("Press the hotkey anywhere to dictate into the app you are using.",
                8.5f, FontStyle.Regular, new Point(26, 252));
            _hint.ForeColor = Color.FromArgb(139, 148, 158);
            Controls.Add(_hint);

            Label historyLabel = MakeLabel("Recent dictation", 8.5f, FontStyle.Bold, new Point(26, 280));
            Controls.Add(historyLabel);

            Button clear = new Button();
            clear.Text = "Clear history";
            clear.Size = new Size(110, 24);
            clear.Location = new Point(490, 276);
            clear.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            clear.FlatStyle = FlatStyle.Flat;
            clear.BackColor = Color.FromArgb(33, 38, 45);
            clear.ForeColor = Color.FromArgb(230, 237, 243);
            clear.FlatAppearance.BorderSize = 0;
            clear.Click += delegate { if (ClearHistoryRequested != null) ClearHistoryRequested(this, EventArgs.Empty); };
            Controls.Add(clear);

            _history = new ListView();
            _history.Location = new Point(26, 306);
            _history.Size = new Size(574, 180);
            _history.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
            _history.View = View.Details;
            _history.FullRowSelect = true;
            _history.HeaderStyle = ColumnHeaderStyle.Nonclickable;
            _history.BackColor = Color.FromArgb(22, 27, 34);
            _history.ForeColor = Color.FromArgb(230, 237, 243);
            _history.BorderStyle = BorderStyle.FixedSingle;
            _history.Columns.Add("When", 120);
            _history.Columns.Add("Text", 300);
            _history.Columns.Add("Result", 130);
            _history.DoubleClick += OnHistoryDoubleClick;
            Controls.Add(_history);
        }

        public void SetConnection(bool connected, string detail)
        {
            RunOnUi(delegate
            {
                _connection.Text = "Connection: " + (connected ? "connected" : "disconnected");
                _connection.ForeColor = connected ? Color.FromArgb(34, 197, 94) : Color.FromArgb(239, 68, 68);
                if (!string.IsNullOrEmpty(detail)) _connection.Text += " - " + detail;
            });
        }

        public void SetMicrophone(bool ready, string detail)
        {
            RunOnUi(delegate
            {
                _mic.Text = "Microphone: " + (ready ? "ready" : "unavailable");
                _mic.ForeColor = ready ? Color.FromArgb(230, 237, 243) : Color.FromArgb(234, 179, 8);
                if (!string.IsNullOrEmpty(detail)) _mic.Text += " - " + detail;
            });
        }

        public void SetDictationState(string label, bool recording)
        {
            RunOnUi(delegate
            {
                _state.Text = label;
                _dictate.Text = recording ? "Stop dictation" : "Start dictation";
            });
        }

        public void SetTranscript(string text)
        {
            RunOnUi(delegate
            {
                _transcript.Text = text ?? "";
                _copy.Enabled = !string.IsNullOrEmpty(text);
            });
        }

        public void SetHint(string text)
        {
            RunOnUi(delegate { _hint.Text = text; });
        }

        public void ShowHistory(List<HistoryEntry> entries)
        {
            RunOnUi(delegate
            {
                _history.BeginUpdate();
                _history.Items.Clear();
                if (entries.Count == 0)
                {
                    ListViewItem empty = new ListViewItem("Nothing dictated yet.");
                    empty.ForeColor = Color.FromArgb(139, 148, 158);
                    _history.Items.Add(empty);
                }
                for (int i = 0; i < entries.Count; i++)
                {
                    HistoryEntry e = entries[i];
                    string when = e.Timestamp > 0
                        ? new DateTime(1970, 1, 1).AddMilliseconds(e.Timestamp).ToLocalTime().ToString("MMM d, HH:mm")
                        : "";
                    string preview = e.Text ?? "";
                    if (preview.Length > 80) preview = preview.Substring(0, 80) + "...";
                    string result = e.Inserted ? "inserted" : "not inserted";
                    if (e.Enhanced) result += ", enhanced";
                    ListViewItem item = new ListViewItem(new string[] { when, preview, result });
                    item.Tag = e;
                    _history.Items.Add(item);
                }
                _history.EndUpdate();
            });
        }

        private void OnHistoryDoubleClick(object sender, EventArgs e)
        {
            if (_history.SelectedItems.Count == 0) return;
            HistoryEntry entry = _history.SelectedItems[0].Tag as HistoryEntry;
            if (entry != null && ReinsertRequested != null) ReinsertRequested(this, entry);
        }

        private void RunOnUi(Action action)
        {
            if (IsDisposed) return;
            if (InvokeRequired) BeginInvoke(action);
            else action();
        }

        private Label MakeLabel(string text, float size, FontStyle style, Point at)
        {
            Label l = new Label();
            l.Text = text;
            l.Font = new Font("Segoe UI", size, style);
            l.ForeColor = Color.FromArgb(230, 237, 243);
            l.Location = at;
            l.AutoSize = true;
            return l;
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // Closing the window hides it; the tray owns the real exit.
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
            }
        }
    }

    /// <summary>Settings dialog. Writes back into the supplied settings object on OK.</summary>
    internal sealed class TalkitySettingsForm : Form
    {
        private readonly TalkitySettings _settings;
        private readonly ComboBox _hotkey;
        private readonly ComboBox _language;
        private readonly ComboBox _whisperLanguage;
        private readonly ComboBox _tone;
        private readonly ComboBox _engine;
        private readonly CheckBox _enhance;
        private readonly CheckBox _startup;
        private readonly CheckBox _tray;
        private readonly CheckBox _hud;
        private readonly CheckBox _history;
        private readonly CheckBox _sound;
        private readonly NumericUpDown _historyLimit;

        public TalkitySettingsForm(TalkitySettings settings)
        {
            _settings = settings;
            Text = "Talkity Settings";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MaximizeBox = false;
            MinimizeBox = false;
            Size = new Size(440, 630);
            BackColor = Color.FromArgb(13, 17, 23);
            ForeColor = Color.FromArgb(230, 237, 243);
            Font = new Font("Segoe UI", 9.5f);

            int y = 20;
            AddLabel("Dictation hotkey", y); y += 22;
            _hotkey = AddCombo(y, new string[] { "F6", "F7", "F8", "F9", "F10", "CTRL+SHIFT+SPACE", "CTRL+SPACE" }, settings.Hotkey);
            y += 40;

            AddLabel("Transcription engine", y); y += 22;
            _engine = AddCombo(y, new string[] { "system_speech", "whisper" }, settings.TranscriptionEngine);
            y += 40;

            AddLabel("Recognition language (System.Speech)", y); y += 22;
            _language = AddCombo(y, new string[] { "en-US", "en-GB", "en-IN", "en-AU" }, settings.Language);
            y += 40;

            AddLabel("Whisper language (auto detects Hindi/Hinglish)", y); y += 22;
            _whisperLanguage = AddCombo(y, new string[]
            {
                "auto", "en", "hi", "es", "fr", "de", "pt", "it", "nl", "ja",
                "ko", "zh", "ar", "ru", "tr", "id", "vi", "th", "pl", "uk"
            }, settings.WhisperLanguage);
            y += 40;

            _enhance = AddCheck("Enhance dictated text (grammar, punctuation, filler removal)", y, settings.EnhanceText);
            y += 30;
            AddLabel("Enhancement style", y); y += 22;
            _tone = AddCombo(y, new string[] { "clean", "concise", "professional", "prompt", "code" }, settings.Tone);
            y += 40;

            _startup = AddCheck("Launch Talkity when Windows starts", y, settings.LaunchAtStartup); y += 28;
            _tray = AddCheck("Keep running in the system tray when closed", y, settings.MinimizeToTray); y += 28;
            _hud = AddCheck("Show the floating dictation indicator", y, settings.ShowHud); y += 28;
            _sound = AddCheck("Play sound cues when recording starts and stops", y, settings.SoundCues); y += 28;
            _history = AddCheck("Keep a local dictation history", y, settings.KeepHistory); y += 28;

            AddLabel("History entries to keep", y + 4);
            _historyLimit = new NumericUpDown();
            _historyLimit.Location = new Point(220, y);
            _historyLimit.Size = new Size(70, 24);
            _historyLimit.Minimum = 10;
            _historyLimit.Maximum = 1000;
            _historyLimit.Value = Math.Min(1000, Math.Max(10, settings.HistoryLimit));
            _historyLimit.BackColor = Color.FromArgb(22, 27, 34);
            _historyLimit.ForeColor = Color.FromArgb(230, 237, 243);
            Controls.Add(_historyLimit);

            Button ok = new Button();
            ok.Text = "Save";
            ok.Size = new Size(90, 30);
            ok.Location = new Point(220, 540);
            ok.FlatStyle = FlatStyle.Flat;
            ok.BackColor = Color.FromArgb(0, 150, 170);
            ok.ForeColor = Color.White;
            ok.FlatAppearance.BorderSize = 0;
            ok.Click += delegate { Commit(); DialogResult = DialogResult.OK; Close(); };
            Controls.Add(ok);

            Button cancel = new Button();
            cancel.Text = "Cancel";
            cancel.Size = new Size(90, 30);
            cancel.Location = new Point(320, 540);
            cancel.DialogResult = DialogResult.Cancel;
            cancel.FlatStyle = FlatStyle.Flat;
            cancel.BackColor = Color.FromArgb(33, 38, 45);
            cancel.ForeColor = Color.FromArgb(230, 237, 243);
            cancel.FlatAppearance.BorderSize = 0;
            Controls.Add(cancel);

            AcceptButton = ok;
            CancelButton = cancel;
        }

        private void Commit()
        {
            _settings.Hotkey = (string)_hotkey.SelectedItem;
            _settings.TranscriptionEngine = (string)_engine.SelectedItem;
            _settings.Language = (string)_language.SelectedItem;
            _settings.WhisperLanguage = (string)_whisperLanguage.SelectedItem;
            _settings.Tone = (string)_tone.SelectedItem;
            _settings.EnhanceText = _enhance.Checked;
            _settings.LaunchAtStartup = _startup.Checked;
            _settings.MinimizeToTray = _tray.Checked;
            _settings.ShowHud = _hud.Checked;
            _settings.SoundCues = _sound.Checked;
            _settings.KeepHistory = _history.Checked;
            _settings.HistoryLimit = (int)_historyLimit.Value;
        }

        private void AddLabel(string text, int y)
        {
            Label l = new Label();
            l.Text = text;
            l.Location = new Point(20, y);
            l.AutoSize = true;
            l.ForeColor = Color.FromArgb(139, 148, 158);
            Controls.Add(l);
        }

        private ComboBox AddCombo(int y, string[] items, string selected)
        {
            ComboBox c = new ComboBox();
            c.Location = new Point(20, y);
            c.Size = new Size(380, 24);
            c.DropDownStyle = ComboBoxStyle.DropDownList;
            c.BackColor = Color.FromArgb(22, 27, 34);
            c.ForeColor = Color.FromArgb(230, 237, 243);
            c.Items.AddRange(items);
            int idx = 0;
            for (int i = 0; i < items.Length; i++) if (items[i] == selected) idx = i;
            c.SelectedIndex = idx;
            Controls.Add(c);
            return c;
        }

        private CheckBox AddCheck(string text, int y, bool value)
        {
            CheckBox c = new CheckBox();
            c.Text = text;
            c.Location = new Point(20, y);
            c.AutoSize = true;
            c.ForeColor = Color.FromArgb(230, 237, 243);
            c.Checked = value;
            Controls.Add(c);
            return c;
        }
    }
}
