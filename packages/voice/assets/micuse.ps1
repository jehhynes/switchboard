# Reports whether any other process records from a microphone (voice-design § 2.3): one JSON line on stdout each time that changes,
# {"busy": true|false, "apps": ["<process name>", ...]}. Core Audio session notifications on every active capture endpoint, re-attached when
# the endpoints change; the excluded process (the voice process), the processes it started (its capture helper) and the system-sounds
# session never count. Exits when stdin closes.
param([int]$ExcludePid = 0)
$ErrorActionPreference = 'Stop'
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace SwitchboardMicUse {
  enum EDataFlow { eRender, eCapture, eAll }
  enum ERole { eConsole, eMultimedia, eCommunications }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCo { }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    void EnumAudioEndpoints(EDataFlow flow, uint stateMask, out IMMDeviceCollection devices);
    void GetDefaultAudioEndpoint(EDataFlow flow, ERole role, out IMMDevice device);
    void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    void RegisterEndpointNotificationCallback(IMMNotificationClient client);
    void UnregisterEndpointNotificationCallback(IMMNotificationClient client);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    void GetCount(out uint count);
    void Item(uint index, out IMMDevice device);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    void Activate(ref Guid iid, uint clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    void OpenPropertyStore(uint access, out IntPtr store);
    void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    void GetState(out uint state);
  }
  [StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_BASIC_INFORMATION {
    public IntPtr ExitStatus; public IntPtr PebBaseAddress; public IntPtr AffinityMask; public IntPtr BasePriority; public IntPtr UniqueProcessId; public IntPtr InheritedFromUniqueProcessId;
  }
  static class Native {
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref PROCESS_BASIC_INFORMATION info, int size, out int returned);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

    // When pid started, as a FILETIME, or 0 when it cannot be read.
    public static long StartOf(uint pid) {
      IntPtr handle = OpenProcess(0x1000, false, pid);
      if (handle == IntPtr.Zero) return 0;
      try {
        long creation, exit, kernel, user;
        return GetProcessTimes(handle, out creation, out exit, out kernel, out user) ? creation : 0;
      } finally { CloseHandle(handle); }
    }

    // Whether pid was started by the process parent, which started at parentStart: a process older than parent had another parent that
    // used the same ID, so it counts.
    public static bool StartedBy(uint pid, uint parent, long parentStart) {
      if (parent == 0 || parentStart == 0 || ParentOf(pid) != parent) return false;
      long start = StartOf(pid);
      return start != 0 && start >= parentStart;
    }

    // The process that started pid, or 0 when it cannot be read.
    public static uint ParentOf(uint pid) {
      IntPtr handle = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
      if (handle == IntPtr.Zero) return 0;
      try {
        var info = new PROCESS_BASIC_INFORMATION();
        int returned;
        return NtQueryInformationProcess(handle, 0, ref info, Marshal.SizeOf(info), out returned) == 0 ? (uint)info.InheritedFromUniqueProcessId.ToInt64() : 0;
      } finally { CloseHandle(handle); }
    }
  }
  [ComImport, Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMNotificationClient {
    [PreserveSig] int OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)] string id, uint state);
    [PreserveSig] int OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)] string id);
    [PreserveSig] int OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)] string id);
    [PreserveSig] int OnDefaultDeviceChanged(EDataFlow flow, ERole role, [MarshalAs(UnmanagedType.LPWStr)] string id);
    [PreserveSig] int OnPropertyValueChanged([MarshalAs(UnmanagedType.LPWStr)] string id, PROPERTYKEY key);
  }
  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    void GetAudioSessionControl(IntPtr guid, uint flags, out IntPtr ctl);
    void GetSimpleAudioVolume(IntPtr guid, uint flags, out IntPtr vol);
    void GetSessionEnumerator(out IAudioSessionEnumerator e);
    void RegisterSessionNotification(IAudioSessionNotification n);
    void UnregisterSessionNotification(IAudioSessionNotification n);
    void RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr n);
    void UnregisterDuckNotification(IntPtr n);
  }
  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    void GetCount(out int c);
    void GetSession(int i, out IAudioSessionControl s);
  }
  [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl {
    void GetState(out int state);
    void GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string n);
    void SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string n, IntPtr ctx);
    void GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string n);
    void SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string n, IntPtr ctx);
    void GetGroupingParam(out Guid g);
    void SetGroupingParam(ref Guid g, IntPtr ctx);
    void RegisterAudioSessionNotification(IAudioSessionEvents e);
    void UnregisterAudioSessionNotification(IAudioSessionEvents e);
  }
  [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    void GetState(out int state);
    void GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string n);
    void SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string n, IntPtr ctx);
    void GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string n);
    void SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string n, IntPtr ctx);
    void GetGroupingParam(out Guid g);
    void SetGroupingParam(ref Guid g, IntPtr ctx);
    void RegisterAudioSessionNotification(IAudioSessionEvents e);
    void UnregisterAudioSessionNotification(IAudioSessionEvents e);
    void GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string s);
    void GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string s);
    void GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession();
    void SetDuckingPreference(bool optOut);
  }
  [ComImport, Guid("641DD20B-4D41-49CC-ABA3-174B9477BB08"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionNotification {
    [PreserveSig] int OnSessionCreated(IAudioSessionControl s);
  }
  [ComImport, Guid("24918ACC-64B3-37C1-8CA9-74A66E9957A8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEvents {
    [PreserveSig] int OnDisplayNameChanged([MarshalAs(UnmanagedType.LPWStr)] string n, ref Guid ctx);
    [PreserveSig] int OnIconPathChanged([MarshalAs(UnmanagedType.LPWStr)] string n, ref Guid ctx);
    [PreserveSig] int OnSimpleVolumeChanged(float v, int mute, ref Guid ctx);
    [PreserveSig] int OnChannelVolumeChanged(uint count, IntPtr arr, uint changed, ref Guid ctx);
    [PreserveSig] int OnGroupingParamChanged(ref Guid g, ref Guid ctx);
    [PreserveSig] int OnStateChanged(int state);
    [PreserveSig] int OnSessionDisconnected(int reason);
  }

  class Session : IAudioSessionEvents {
    public Watch Owner; public string Endpoint; public uint Pid; public string Name; public bool Active;
    public int OnDisplayNameChanged(string n, ref Guid c) { return 0; }
    public int OnIconPathChanged(string n, ref Guid c) { return 0; }
    public int OnSimpleVolumeChanged(float v, int m, ref Guid c) { return 0; }
    public int OnChannelVolumeChanged(uint a, IntPtr b, uint d, ref Guid c) { return 0; }
    public int OnGroupingParamChanged(ref Guid g, ref Guid c) { return 0; }
    // 0 inactive, 1 active, 2 expired.
    public int OnStateChanged(int s) { Owner.Changed(this, s == 1); return 0; }
    public int OnSessionDisconnected(int r) { Owner.Changed(this, false); return 0; }
  }

  class Created : IAudioSessionNotification {
    public Watch Owner; public string Endpoint;
    public int OnSessionCreated(IAudioSessionControl s) { Owner.Track(s, Endpoint); return 0; }
  }

  class Devices : IMMNotificationClient {
    public Watch Owner;
    public int OnDeviceStateChanged(string id, uint state) { Owner.Rescan(); return 0; }
    public int OnDeviceAdded(string id) { Owner.Rescan(); return 0; }
    public int OnDeviceRemoved(string id) { Owner.Rescan(); return 0; }
    public int OnDefaultDeviceChanged(EDataFlow flow, ERole role, string id) { Owner.Rescan(); return 0; }
    public int OnPropertyValueChanged(string id, PROPERTYKEY key) { return 0; }
  }

  public class Watch {
    readonly object gate = new object();
    readonly uint exclude;
    readonly long excludeStart;
    readonly List<object> keep = new List<object>();
    readonly Dictionary<string, object> endpoints = new Dictionary<string, object>();
    readonly List<Session> sessions = new List<Session>();
    IMMDeviceEnumerator enumerator;
    string last = null;

    public Watch(uint excludePid) { exclude = excludePid; excludeStart = excludePid == 0 ? 0 : Native.StartOf(excludePid); }

    // COM registration happens on an MTA thread, as the spike found it must.
    public void Start() {
      var started = new ManualResetEvent(false);
      Exception failed = null;
      var thread = new Thread(() => {
        try {
          enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorCo();
          var devices = new Devices { Owner = this };
          keep.Add(devices);
          enumerator.RegisterEndpointNotificationCallback(devices);
          Rescan();
        } catch (Exception e) { failed = e; }
        started.Set();
      });
      thread.SetApartmentState(ApartmentState.MTA);
      thread.IsBackground = true;
      thread.Start();
      started.WaitOne();
      if (failed != null) throw failed;
      Report();
    }

    // Watches every active capture endpoint not watched yet; sessions of an endpoint that is no longer active stop counting.
    internal void Rescan() {
      ThreadPool.QueueUserWorkItem(_ => {
        try {
          lock (gate) {
            IMMDeviceCollection list;
            enumerator.EnumAudioEndpoints(EDataFlow.eCapture, 1, out list);
            uint count; list.GetCount(out count);
            var active = new HashSet<string>();
            for (uint i = 0; i < count; i++) {
              IMMDevice device; list.Item(i, out device);
              string id; device.GetId(out id);
              active.Add(id);
              if (endpoints.ContainsKey(id)) continue;
              var iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
              object o; device.Activate(ref iid, 0x17, IntPtr.Zero, out o);
              var manager = (IAudioSessionManager2)o;
              IAudioSessionEnumerator existing; manager.GetSessionEnumerator(out existing);
              var created = new Created { Owner = this, Endpoint = id };
              endpoints[id] = manager;
              keep.Add(manager); keep.Add(existing); keep.Add(created);
              manager.RegisterSessionNotification(created);
              int n; existing.GetCount(out n);
              for (int j = 0; j < n; j++) { IAudioSessionControl s; existing.GetSession(j, out s); Track(s, id); }
            }
            foreach (var gone in new List<string>(endpoints.Keys)) {
              if (!active.Contains(gone)) { endpoints.Remove(gone); sessions.RemoveAll(s => s.Endpoint == gone); }
            }
          }
        } catch (Exception e) { Console.Error.WriteLine("rescan failed: " + e.Message); }
        Report();
      });
    }

    internal void Track(IAudioSessionControl control, string endpoint) {
      try {
        var two = (IAudioSessionControl2)control;
        if (two.IsSystemSoundsSession() == 0) return;
        uint pid; two.GetProcessId(out pid);
        if (pid == 0 || pid == exclude || Native.StartedBy(pid, exclude, excludeStart)) return;
        int state; control.GetState(out state);
        string name = "process " + pid;
        try { name = Process.GetProcessById((int)pid).ProcessName; } catch { }
        var session = new Session { Owner = this, Endpoint = endpoint, Pid = pid, Name = name, Active = state == 1 };
        lock (gate) { sessions.Add(session); keep.Add(control); keep.Add(session); }
        control.RegisterAudioSessionNotification(session);
      } catch (Exception e) { Console.Error.WriteLine("session failed: " + e.Message); }
      Report();
    }

    internal void Changed(Session session, bool active) {
      lock (gate) { session.Active = active; }
      Report();
    }

    void Report() {
      string line;
      lock (gate) {
        var apps = new SortedSet<string>();
        foreach (var s in sessions) if (s.Active) apps.Add(s.Name);
        var names = new List<string>();
        foreach (var a in apps) names.Add("\"" + a.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"");
        line = "{\"busy\":" + (apps.Count > 0 ? "true" : "false") + ",\"apps\":[" + string.Join(",", names) + "]}";
        if (line == last) return;
        last = line;
      }
      lock (Console.Out) { Console.Out.WriteLine(line); Console.Out.Flush(); }
    }
  }
}
'@
$watch = New-Object SwitchboardMicUse.Watch ([uint32]$ExcludePid)
$watch.Start()
while ($null -ne [Console]::In.ReadLine()) { }
