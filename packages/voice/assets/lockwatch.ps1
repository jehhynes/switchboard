# Reports when this Windows session locks or unlocks, the computer goes to sleep or wakes, or the session disconnects from or connects to
# its console or a Remote Desktop client (architecture.md § Dictation): one JSON line on stdout per event, {"event": "locked" | "unlocked" |
# "asleep" | "awake" | "disconnected" | "connected"}, and at start "disconnected" or "locked" when the session already is. A hidden top-level
# window receives the session notifications (WTSRegisterSessionNotification) and the power broadcasts. Exits when stdin closes.
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace SwitchboardLockWatch {
  public class Watch : NativeWindow {
    const int WM_WTSSESSION_CHANGE = 0x02B1;
    const int WM_POWERBROADCAST = 0x0218;
    const int NOTIFY_FOR_THIS_SESSION = 0;
    const int WTS_CURRENT_SESSION = -1;
    const int WTSSessionInfoEx = 25;

    [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSRegisterSessionNotification(IntPtr hWnd, int flags);
    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool WTSQuerySessionInformationW(IntPtr server, int sessionId, int infoClass, out IntPtr buffer, out int bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);

    public Watch() {
      var created = new CreateParams();
      created.Caption = "Switchboard lock watch";
      CreateHandle(created);
      if (!WTSRegisterSessionNotification(Handle, NOTIFY_FOR_THIS_SESSION)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    // The session's state at start, from WTSINFOEX_LEVEL1: the union after Level is 8-aligned (it holds a LARGE_INTEGER), so SessionId is at
    // offset 8, SessionState (WTSDisconnected = 4) at 12 and SessionFlags (WTS_SESSIONSTATE_LOCK = 0) at 16.
    public void Initial() {
      IntPtr buffer;
      int bytes;
      if (!WTSQuerySessionInformationW(IntPtr.Zero, WTS_CURRENT_SESSION, WTSSessionInfoEx, out buffer, out bytes)) {
        Console.Error.WriteLine("reading the session's state failed: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
        return;
      }
      try {
        if (bytes < 20 || Marshal.ReadInt32(buffer, 0) != 1 || Marshal.ReadInt32(buffer, 8) != Process.GetCurrentProcess().SessionId) {
          Console.Error.WriteLine("reading the session's state failed: unexpected WTSINFOEX");
          return;
        }
        if (Marshal.ReadInt32(buffer, 12) == 4) Emit("disconnected");
        if (Marshal.ReadInt32(buffer, 16) == 0) Emit("locked");
      } finally {
        WTSFreeMemory(buffer);
      }
    }

    protected override void WndProc(ref Message m) {
      if (m.Msg == WM_WTSSESSION_CHANGE) {
        switch (m.WParam.ToInt32()) {
          case 1: case 3: Emit("connected"); break;     // WTS_CONSOLE_CONNECT, WTS_REMOTE_CONNECT
          case 2: case 4: Emit("disconnected"); break;  // WTS_CONSOLE_DISCONNECT, WTS_REMOTE_DISCONNECT
          case 7: Emit("locked"); break;                // WTS_SESSION_LOCK
          case 8: Emit("unlocked"); break;              // WTS_SESSION_UNLOCK
        }
      } else if (m.Msg == WM_POWERBROADCAST) {
        switch (m.WParam.ToInt32()) {
          case 4: Emit("asleep"); break;                // PBT_APMSUSPEND
          case 7: case 0x12: Emit("awake"); break;      // PBT_APMRESUMESUSPEND, PBT_APMRESUMEAUTOMATIC
        }
      }
      base.WndProc(ref m);
    }

    static void Emit(string name) {
      lock (Console.Out) { Console.Out.WriteLine("{\"event\":\"" + name + "\"}"); Console.Out.Flush(); }
    }

    // Ends the process when stdin closes, as when the voice process exits.
    public static void ExitWhenInputEnds() {
      var reader = new Thread(() => { while (Console.In.ReadLine() != null) { } Environment.Exit(0); });
      reader.IsBackground = true;
      reader.Start();
    }
  }
}
'@
$watch = New-Object SwitchboardLockWatch.Watch
$watch.Initial()
[SwitchboardLockWatch.Watch]::ExitWhenInputEnds()
[System.Windows.Forms.Application]::Run()
