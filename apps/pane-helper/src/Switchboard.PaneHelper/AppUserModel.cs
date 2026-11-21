using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Switchboard.PaneHelper;

/// <summary>
/// A window's AppUserModelID, which the pane's log shows: Chrome gives an installed web app's windows <c>Chrome._crx_…</c> and its other windows
/// the browser's own.
/// </summary>
[SupportedOSPlatform("windows")]
static class AppUserModel
{
    static Guid storeId = new("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");

    /// <summary>The window's AppUserModelID, or null when it has none or it cannot be read.</summary>
    public static string? Of(nint window)
    {
        if (SHGetPropertyStoreForWindow(window, ref storeId, out var store) != 0 || store is null)
        {
            return null;
        }

        try
        {
            var key = new PropertyKey { Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Id = 5 };

            if (store.GetValue(ref key, out var value) != 0)
            {
                return null;
            }

            try
            {
                // VT_LPWSTR
                return value.Type == 31 && value.Pointer != 0 ? Marshal.PtrToStringUni(value.Pointer) : null;
            }
            finally
            {
                PropVariantClear(ref value);
            }
        }
        finally
        {
            Marshal.ReleaseComObject(store);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PropertyKey
    {
        public Guid Format;
        public uint Id;
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PropVariant
    {
        [FieldOffset(0)]
        public ushort Type;

        [FieldOffset(8)]
        public nint Pointer;
    }

    [ComImport]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        [PreserveSig]
        int GetCount(out uint count);

        [PreserveSig]
        int GetAt(uint index, out PropertyKey key);

        [PreserveSig]
        int GetValue(ref PropertyKey key, out PropVariant value);

        [PreserveSig]
        int SetValue(ref PropertyKey key, ref PropVariant value);

        [PreserveSig]
        int Commit();
    }

    [DllImport("shell32.dll")]
    static extern int SHGetPropertyStoreForWindow(nint window, ref Guid id, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore? store);

    [DllImport("ole32.dll")]
    static extern int PropVariantClear(ref PropVariant value);
}
