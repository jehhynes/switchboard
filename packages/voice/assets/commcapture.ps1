# Captures the default (or named) microphone in communications mode, the mode calls use, so Windows applies its own echo cancellation
# against what the speakers play, with no reference to feed (architecture.md § Dictation, mechanics.md M94). Writes 16 kHz mono 16-bit PCM
# to stdout until stdin closes. stderr carries JSON lines: first the device, the speakers, the mode, the audio effects Windows applies (echo
# cancellation among them, or not), the echo reference and whether this is a Remote Desktop session; or {"error"}; and, once stdin closes, how many packets after the first Windows
# marked as following lost audio. -List initializes the stream and reports without recording. -DefaultMode captures in the default mode,
# as other apps and decibri do. -Device picks the capture device whose name contains it, and -Speakers the playback device, the echo
# reference, whose name contains it; each defaults to the system default.
param([string]$Device = '', [string]$Speakers = '', [switch]$List, [switch]$DefaultMode)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace SbCommCapture {
  [StructLayout(LayoutKind.Sequential)] public struct PropertyKey { public Guid fmtid; public int pid; }
  [StructLayout(LayoutKind.Sequential)] public struct PropVariant { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr p; public IntPtr p2; }
  [StructLayout(LayoutKind.Sequential)] public struct ClientProperties { public uint cbSize; public int bIsOffload; public int eCategory; public int Options; }
  [StructLayout(LayoutKind.Sequential)] public struct AudioEffect { public Guid id; public int canSetState; public int state; }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int Item(int index, out IMMDevice device);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  }
  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetAt(int index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
  }
  [ComImport, Guid("726778CD-F60A-4eda-82DE-E47610CD78AA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioClient2 {
    [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint frames);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    [PreserveSig] int IsOffloadCapable(int category, out int capable);
    [PreserveSig] int SetClientProperties(ref ClientProperties properties);
  }
  [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioCaptureClient {
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
  }
  [ComImport, Guid("4460B3AE-4B44-4527-8676-7548A8ACD260"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioEffectsManager {
    [PreserveSig] int RegisterAudioEffectsChangedNotificationCallback(IntPtr client);
    [PreserveSig] int UnregisterAudioEffectsChangedNotificationCallback(IntPtr client);
    [PreserveSig] int GetAudioEffects(out IntPtr effects, out uint count);
  }
  [ComImport, Guid("f4ae25b5-aaa3-437d-b6b3-dbbe2d0e9549"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAcousticEchoCancellationControl {
    [PreserveSig] int SetEchoCancellationRenderEndpoint([MarshalAs(UnmanagedType.LPWStr)] string endpointId);
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumerator {}

  public static class Capture {
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    const int SmRemoteSession = 0x1000;
    const int Render = 0, CaptureFlow = 1, Console = 0, Active = 1;
    const uint AutoConvert = 0x80000000, SrcDefaultQuality = 0x08000000;
    const int Communications = 3, Other = 0;

    static string Name(IMMDevice device) {
      IPropertyStore store;
      if (device.OpenPropertyStore(0, out store) != 0) return "?";
      PropertyKey key = new PropertyKey { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
      PropVariant value;
      if (store.GetValue(ref key, out value) != 0 || value.vt != 31) return "?";
      return Marshal.PtrToStringUni(value.p);
    }

    static string Effect(Guid id) {
      string text = id.ToString().ToLowerInvariant();
      if (text == "6f64adbe-8211-11e2-8c70-2c27d7f001fa") return "acoustic echo cancellation";
      if (text == "6f64adbf-8211-11e2-8c70-2c27d7f001fa") return "noise suppression";
      if (text == "6f64adc0-8211-11e2-8c70-2c27d7f001fa") return "automatic gain control";
      return text;
    }

    static string Json(string text) {
      StringBuilder builder = new StringBuilder("\"");
      foreach (char c in text) {
        if (c == '"' || c == '\\') builder.Append('\\').Append(c);
        else if (c < ' ') builder.Append(' ');
        else builder.Append(c);
      }
      return builder.Append('"').ToString();
    }

    static void Check(int hr, string what) {
      if (hr != 0) throw new Exception(what + " failed: 0x" + hr.ToString("X8"));
    }

    public static int Run(string wanted, string wantedSpeakers, bool listOnly, bool defaultMode) {
      IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice device = null;
      if (wanted.Length > 0) {
        IMMDeviceCollection all;
        Check(enumerator.EnumAudioEndpoints(CaptureFlow, Active, out all), "EnumAudioEndpoints");
        int count;
        all.GetCount(out count);
        for (int index = 0; index < count && device == null; index++) {
          IMMDevice one;
          all.Item(index, out one);
          if (Name(one).IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0) device = one;
        }
        if (device == null) throw new Exception("No capture device matches " + wanted);
      } else {
        Check(enumerator.GetDefaultAudioEndpoint(CaptureFlow, Console, out device), "GetDefaultAudioEndpoint");
      }

      // The speakers the voice plays through: the render device whose name contains wantedSpeakers, else the default one.
      IMMDevice speakers = null;
      string speakersId = null, speakersName = null;
      if (wantedSpeakers.Length > 0) {
        IMMDeviceCollection outputs;
        if (enumerator.EnumAudioEndpoints(Render, Active, out outputs) == 0) {
          int outputCount;
          outputs.GetCount(out outputCount);
          for (int index = 0; index < outputCount && speakers == null; index++) {
            IMMDevice one;
            outputs.Item(index, out one);
            if (Name(one).IndexOf(wantedSpeakers, StringComparison.OrdinalIgnoreCase) >= 0) speakers = one;
          }
        }
      }
      if (speakers != null || enumerator.GetDefaultAudioEndpoint(Render, Console, out speakers) == 0) {
        speakers.GetId(out speakersId);
        speakersName = Name(speakers);
      }

      Guid clientIid = new Guid("726778CD-F60A-4eda-82DE-E47610CD78AA");
      object instance;
      Check(device.Activate(ref clientIid, 23, IntPtr.Zero, out instance), "Activate");
      IAudioClient2 client = (IAudioClient2)instance;
      ClientProperties properties = new ClientProperties { cbSize = 16, bIsOffload = 0, eCategory = defaultMode ? Other : Communications, Options = 0 };
      Check(client.SetClientProperties(ref properties), "SetClientProperties");

      // WAVEFORMATEX: PCM, mono, 16 kHz, 16-bit; Windows converts from the device's own format.
      IntPtr format = Marshal.AllocCoTaskMem(18);
      byte[] wave = new byte[18];
      BitConverter.GetBytes((ushort)1).CopyTo(wave, 0);
      BitConverter.GetBytes((ushort)1).CopyTo(wave, 2);
      BitConverter.GetBytes(16000).CopyTo(wave, 4);
      BitConverter.GetBytes(32000).CopyTo(wave, 8);
      BitConverter.GetBytes((ushort)2).CopyTo(wave, 12);
      BitConverter.GetBytes((ushort)16).CopyTo(wave, 14);
      Marshal.Copy(wave, 0, format, 18);
      Check(client.Initialize(0, AutoConvert | SrcDefaultQuality, 2000000, 0, format, IntPtr.Zero), "Initialize");

      string effects = "[]";
      Guid effectsIid = new Guid("4460B3AE-4B44-4527-8676-7548A8ACD260");
      object effectsService;
      if (client.GetService(ref effectsIid, out effectsService) == 0) {
        IntPtr list;
        uint count;
        if (((IAudioEffectsManager)effectsService).GetAudioEffects(out list, out count) == 0) {
          StringBuilder builder = new StringBuilder("[");
          for (int index = 0; index < count; index++) {
            AudioEffect effect = (AudioEffect)Marshal.PtrToStructure(new IntPtr(list.ToInt64() + index * 24), typeof(AudioEffect));
            if (index > 0) builder.Append(',');
            builder.Append("{\"effect\":").Append(Json(Effect(effect.id))).Append(",\"on\":").Append(effect.state == 1 ? "true" : "false").Append('}');
          }
          effects = builder.Append(']').ToString();
          Marshal.FreeCoTaskMem(list);
        }
      } else {
        effects = "null";
      }

      // Point the echo canceller at the speakers when it lets a caller choose; otherwise Windows picks the reference itself.
      string reference = "chosen by Windows";
      Guid aecIid = new Guid("f4ae25b5-aaa3-437d-b6b3-dbbe2d0e9549");
      object aecService;
      if (speakersId != null && client.GetService(ref aecIid, out aecService) == 0) {
        reference = ((IAcousticEchoCancellationControl)aecService).SetEchoCancellationRenderEndpoint(speakersId) == 0 ? "speakers" : "chosen by Windows (setting the speakers failed)";
      }

      Guid captureIid = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
      object captureService;
      Check(client.GetService(ref captureIid, out captureService), "GetService(IAudioCaptureClient)");
      IAudioCaptureClient capture = (IAudioCaptureClient)captureService;

      string header = "{\"device\":" + Json(Name(device)) + ",\"speakers\":" + Json(speakersName ?? "") + ",\"mode\":" + Json(defaultMode ? "default" : "communications") + ",\"effects\":" + effects + ",\"reference\":" + Json(reference) + ",\"remote\":" + (GetSystemMetrics(SmRemoteSession) != 0 ? "true" : "false") + "}";
      if (listOnly) {
        Console_.Error.WriteLine(header);
        Console_.Error.Flush();
        return 0;
      }

      bool stop = false;
      Thread reader = new Thread(delegate () {
        try { Stream input = Console_.OpenStandardInput(); byte[] sink = new byte[256]; while (input.Read(sink, 0, sink.Length) > 0) { } } catch (Exception) { }
        stop = true;
      });
      reader.IsBackground = true;
      reader.Start();

      Stream output = Console_.OpenStandardOutput();
      Check(client.Start(), "Start");
      // The header says the stream records, so it comes only once Start succeeded.
      Console_.Error.WriteLine(header);
      Console_.Error.Flush();
      byte[] buffer = new byte[0];
      bool first = true;
      long discontinuities = 0;
      try {
        while (!stop) {
          uint packet;
          Check(capture.GetNextPacketSize(out packet), "GetNextPacketSize");
          if (packet == 0) { Thread.Sleep(5); continue; }
          IntPtr data; uint frames, flags; ulong position, qpc;
          Check(capture.GetBuffer(out data, out frames, out flags, out position, out qpc), "GetBuffer");
          // AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY: audio was lost before this packet. The first packet always carries it. The device position
          // counts the device's own frames, not the converted 16 kHz ones, so it cannot measure the gap.
          if (!first && (flags & 1) != 0) discontinuities++;
          first = false;
          int bytes = (int)frames * 2;
          if (buffer.Length < bytes) buffer = new byte[bytes];
          // AUDCLNT_BUFFERFLAGS_SILENT: the data is to be read as silence.
          if ((flags & 2) != 0) Array.Clear(buffer, 0, bytes); else Marshal.Copy(data, buffer, 0, bytes);
          capture.ReleaseBuffer(frames);
          output.Write(buffer, 0, bytes);
          output.Flush();
        }
      } catch (IOException) {
      } finally {
        client.Stop();
        Console_.Error.WriteLine("{\"discontinuities\":" + discontinuities + "}");
        Console_.Error.Flush();
      }
      return 0;
    }
  }

  static class Console_ {
    public static TextWriter Error { get { return System.Console.Error; } }
    public static Stream OpenStandardInput() { return System.Console.OpenStandardInput(); }
    public static Stream OpenStandardOutput() { return System.Console.OpenStandardOutput(); }
  }
}
'@

try {
  exit [SbCommCapture.Capture]::Run($Device, $Speakers, [bool]$List, [bool]$DefaultMode)
} catch {
  [Console]::Error.WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
  exit 1
}
