using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;
using StarMicronics.StarIO;
using StarMicronics.StarIOExtension;

namespace LBj.PrinterModules.StarTsp100
{
    internal static class Program
    {
        private const int ApiVersion = 1;
        private const int MaximumRequestCharacters = 24 * 1024 * 1024;

        private static int Main(string[] args)
        {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);

            var serializer = new JavaScriptSerializer { MaxJsonLength = MaximumRequestCharacters };
            try
            {
                if (args.Length != 1 || !string.Equals(args[0], "--lbj-printer-module", StringComparison.Ordinal))
                {
                    WriteResponse(serializer, Failure("This program must be started by L&Bj POS."));
                    return 0;
                }

                var raw = Console.In.ReadToEnd();
                if (string.IsNullOrWhiteSpace(raw) || raw.Length > MaximumRequestCharacters)
                {
                    WriteResponse(serializer, Failure("The printer-module request is empty or too large."));
                    return 0;
                }

                var request = serializer.DeserializeObject(raw) as IDictionary<string, object>;
                if (request == null)
                {
                    WriteResponse(serializer, Failure("The printer-module request is not valid JSON."));
                    return 0;
                }

                if (ReadInt(request, "apiVersion", 0) != ApiVersion)
                {
                    WriteResponse(serializer, Failure("This Star module needs printer API version 1."));
                    return 0;
                }

                var operation = ReadText(request, "operation");
                var payload = ReadDictionary(request, "payload");
                var requestId = ReadLong(request, "requestId", 0);
                var adapter = new StarTsp100Adapter();
                var response = adapter.Execute(operation, payload, requestId);
                WriteResponse(serializer, response);
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("Star module error: " + error.GetType().Name + ": " + error.Message);
                WriteResponse(serializer, Failure(FriendlyError(error)));
                return 0;
            }
        }

        private static IDictionary<string, object> Failure(string message)
        {
            return new Dictionary<string, object>
            {
                { "ok", false },
                { "message", message }
            };
        }

        private static void WriteResponse(JavaScriptSerializer serializer, IDictionary<string, object> response)
        {
            Console.Out.Write(serializer.Serialize(response));
            Console.Out.Flush();
        }

        private static string FriendlyError(Exception error)
        {
            if (error is PortException)
            {
                return "The Star printer could not be reached. Check its USB cable, power, paper, Windows driver, and that another program is not using it. " + error.Message;
            }

            if (error is BadImageFormatException || error is DllNotFoundException || error is FileNotFoundException)
            {
                return "The Star x64 SDK could not start. Reinstall this module and the Star futurePRNT Windows driver. " + error.Message;
            }

            return error.Message;
        }

        internal static IDictionary<string, object> ReadDictionary(IDictionary<string, object> source, string key)
        {
            object value;
            return source.TryGetValue(key, out value) && value is IDictionary<string, object>
                ? (IDictionary<string, object>)value
                : new Dictionary<string, object>();
        }

        internal static string ReadText(IDictionary<string, object> source, string key, string fallback = "")
        {
            object value;
            return source.TryGetValue(key, out value) && value != null
                ? Convert.ToString(value).Trim()
                : fallback;
        }

        internal static int ReadInt(IDictionary<string, object> source, string key, int fallback)
        {
            object value;
            int parsed;
            return source.TryGetValue(key, out value) && value != null && int.TryParse(Convert.ToString(value), out parsed)
                ? parsed
                : fallback;
        }

        internal static long ReadLong(IDictionary<string, object> source, string key, long fallback)
        {
            object value;
            long parsed;
            return source.TryGetValue(key, out value) && value != null && long.TryParse(Convert.ToString(value), out parsed)
                ? parsed
                : fallback;
        }
    }

    internal sealed class StarTsp100Adapter
    {
        private const int PortTimeoutMilliseconds = 4000;
        private const int MaximumPrintBytes = 15 * 1024 * 1024;
        private static readonly string[] RawProtocols = { "star", "star-graphic", "star-line", "raw" };

        internal IDictionary<string, object> Execute(
            string operation,
            IDictionary<string, object> payload,
            long requestId)
        {
            switch (operation)
            {
                case "getCapabilities":
                    return Capabilities();
                case "healthCheck":
                    return HealthCheck();
                case "discoverDevices":
                    return DiscoverDevices();
                case "getStatus":
                    return GetStatus(payload);
                case "printRaw":
                    return PrintRaw(payload, requestId);
                case "openDrawer":
                    return OpenDrawer(payload, requestId);
                default:
                    throw new InvalidOperationException("The Star TSP100 module does not provide " + operation + ".");
            }
        }

        private static IDictionary<string, object> Capabilities()
        {
            return Success("Star TSP100 module API is ready", new Dictionary<string, object>
            {
                { "capabilities", new[] { "discoverDevices", "printRaw", "openDrawer", "getStatus", "healthCheck" } },
                { "connections", new[] { "usb" } },
                { "protocols", new[] { "star-line", "star-graphic" } },
                { "defaultDeviceId", "" }
            });
        }

        private static IDictionary<string, object> HealthCheck()
        {
            var version = Factory.I.GetStarIOVersion();
            var devices = FindUsbDevices();
            var message = devices.Count == 0
                ? "Star SDK " + version + " is ready; no Star USB printer is currently detected"
                : "Star SDK " + version + " is ready; " + devices.Count + " Star USB printer" + (devices.Count == 1 ? "" : "s") + " detected";
            return Success(message, new Dictionary<string, object>
            {
                { "status", devices.Count == 0 ? "no-device" : "ready" },
                { "sdkVersion", version },
                { "deviceCount", devices.Count }
            });
        }

        private static IDictionary<string, object> DiscoverDevices()
        {
            var devices = FindUsbDevices()
                .Select(DeviceResponse)
                .Cast<object>()
                .ToArray();
            return Success(
                devices.Length == 0 ? "No Star USB printer was found" : devices.Length + " Star USB printer" + (devices.Length == 1 ? "" : "s") + " found",
                new Dictionary<string, object> { { "devices", devices } });
        }

        private static IDictionary<string, object> GetStatus(IDictionary<string, object> payload)
        {
            var requestedDevice = Program.ReadText(payload, "deviceId");
            return WithPort(requestedDevice, delegate(IPort port, string portName)
            {
                var status = port.GetParsedStatus();
                return Success(StatusSummary(status), new Dictionary<string, object>
                {
                    { "deviceId", portName },
                    { "status", StatusResponse(status) }
                });
            });
        }

        private static IDictionary<string, object> PrintRaw(IDictionary<string, object> payload, long requestId)
        {
            var protocol = Program.ReadText(payload, "protocol", "raw").ToLowerInvariant();
            if (!RawProtocols.Contains(protocol))
            {
                throw new InvalidOperationException(
                    "This TSP100 module only accepts Star Line receipts or Star Graphic labels. Select Star Graphic instead of ESC/POS for labels.");
            }

            var encoded = Program.ReadText(payload, "dataBase64");
            byte[] data;
            try
            {
                data = Convert.FromBase64String(encoded);
            }
            catch (FormatException)
            {
                throw new InvalidOperationException("The print job data is damaged.");
            }

            if (data.Length == 0 || data.Length > MaximumPrintBytes)
            {
                throw new InvalidOperationException("The print job is empty or larger than 15 MB.");
            }

            var requestedDevice = Program.ReadText(payload, "deviceId");
            var documentName = Program.ReadText(payload, "documentName", "L&Bj POS Star print job");
            return WithPort(requestedDevice, delegate(IPort port, string portName)
            {
                var before = port.BeginCheckedBlock();
                EnsureOnline(before);
                WriteAll(port, data);
                var after = port.EndCheckedBlock();
                EnsureOnline(after);
                return Success(documentName + " printed", new Dictionary<string, object>
                {
                    { "jobId", "star-" + requestId },
                    { "status", "completed" },
                    { "deviceId", portName },
                    { "bytesWritten", data.Length },
                    { "printerStatus", StatusResponse(after) }
                });
            });
        }

        private static IDictionary<string, object> OpenDrawer(IDictionary<string, object> payload, long requestId)
        {
            var requestedDevice = Program.ReadText(payload, "deviceId");
            var pin = Program.ReadInt(payload, "pin", 0) == 1 ? 1 : 0;
            var pulse = Math.Max(20, Math.Min(500, Program.ReadInt(payload, "pulseOnMs", 200)));
            var builder = StarIoExt.CreateCommandBuilder(Emulation.StarGraphic);
            builder.BeginDocument();
            if (pin == 1)
            {
                builder.AppendPeripheral(PeripheralChannel.No2);
            }
            else
            {
                builder.AppendPeripheral(PeripheralChannel.No1, pulse);
            }
            builder.EndDocument();
            var command = builder.Commands;

            return WithPort(requestedDevice, delegate(IPort port, string portName)
            {
                var before = port.GetParsedStatus();
                EnsureOnline(before);
                WriteAll(port, command);
                return Success("Cash drawer command sent", new Dictionary<string, object>
                {
                    { "jobId", "star-drawer-" + requestId },
                    { "status", "completed" },
                    { "deviceId", portName },
                    { "channel", pin + 1 }
                });
            });
        }

        private static IDictionary<string, object> WithPort(
            string requestedDevice,
            Func<IPort, string, IDictionary<string, object>> action)
        {
            var explicitPort = NormalizeDeviceId(requestedDevice);
            if (!string.IsNullOrWhiteSpace(explicitPort))
            {
                return UsePort(explicitPort, action);
            }

            var candidates = new List<string>();
            var cached = ReadCachedDeviceId();
            if (!string.IsNullOrWhiteSpace(cached)) candidates.Add(cached);
            candidates.Add("USBVEN:");

            Exception lastError = null;
            foreach (var candidate in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                try
                {
                    var result = UsePort(candidate, action);
                    WriteCachedDeviceId(candidate);
                    return result;
                }
                catch (PortException error)
                {
                    lastError = error;
                }
            }

            foreach (var device in FindUsbDevices())
            {
                try
                {
                    var result = UsePort(device.PortName, action);
                    WriteCachedDeviceId(device.PortName);
                    return result;
                }
                catch (PortException error)
                {
                    lastError = error;
                }
            }

            throw new InvalidOperationException(
                "No usable Star USB printer was found. Install the Star futurePRNT driver, connect the printer, and use Check Module again.",
                lastError);
        }

        private static IDictionary<string, object> UsePort(
            string portName,
            Func<IPort, string, IDictionary<string, object>> action)
        {
            IPort port = null;
            try
            {
                port = Factory.I.GetPort(portName, "", PortTimeoutMilliseconds);
                return action(port, portName);
            }
            finally
            {
                if (port != null) Factory.I.ReleasePort(port);
            }
        }

        private static void WriteAll(IPort port, byte[] data)
        {
            uint offset = 0;
            while (offset < data.Length)
            {
                var written = port.WritePort(data, offset, (uint)data.Length - offset);
                if (written == 0)
                {
                    throw new IOException("The Star printer accepted zero bytes from the print job.");
                }
                offset += written;
            }
        }

        private static List<PortInfo> FindUsbDevices()
        {
            var devices = new List<PortInfo>();
            SearchUsb(devices, PrinterInterfaceType.USBVendorClass);
            SearchUsb(devices, PrinterInterfaceType.USBPrinterClass);
            return devices
                .Where(device => device != null && !string.IsNullOrWhiteSpace(device.PortName))
                .GroupBy(device => device.PortName, StringComparer.OrdinalIgnoreCase)
                .Select(group => group.First())
                .OrderByDescending(device => (device.ModelName ?? "").IndexOf("TSP100", StringComparison.OrdinalIgnoreCase) >= 0)
                .ThenBy(device => device.ModelName ?? device.PortName, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        private static void SearchUsb(ICollection<PortInfo> output, PrinterInterfaceType interfaceType)
        {
            try
            {
                foreach (var device in Factory.I.SearchPrinter(interfaceType)) output.Add(device);
            }
            catch (PortException)
            {
                // Some Star driver generations expose only one of the two USB classes.
            }
        }

        private static IDictionary<string, object> DeviceResponse(PortInfo device)
        {
            var model = string.IsNullOrWhiteSpace(device.ModelName) ? "Star printer" : device.ModelName.Trim();
            var serial = string.IsNullOrWhiteSpace(device.USBSerialNumber) ? "" : device.USBSerialNumber.Trim();
            return new Dictionary<string, object>
            {
                { "id", device.PortName },
                { "name", string.IsNullOrWhiteSpace(serial) ? model : model + " (" + serial + ")" },
                { "model", model },
                { "transport", "USB" },
                { "serialNumber", serial }
            };
        }

        private static IDictionary<string, object> StatusResponse(StarPrinterStatus status)
        {
            return new Dictionary<string, object>
            {
                { "online", !status.Offline },
                { "coverOpen", status.CoverOpen },
                { "paperEmpty", status.ReceiptPaperEmpty },
                { "paperNearEmpty", status.ReceiptPaperNearEmptyInner },
                { "cutterError", status.CutterError },
                { "unrecoverableError", status.UnrecoverableError },
                { "drawerSignal", status.CompulsionSwitch }
            };
        }

        private static string StatusSummary(StarPrinterStatus status)
        {
            if (status.CoverOpen) return "Printer cover is open";
            if (status.ReceiptPaperEmpty) return "Printer is out of paper";
            if (status.CutterError) return "Printer cutter needs attention";
            if (status.UnrecoverableError) return "Printer needs attention";
            if (status.Offline) return "Printer is offline";
            if (status.ReceiptPaperNearEmptyInner) return "Printer is ready; paper is low";
            return "Printer is ready";
        }

        private static void EnsureOnline(StarPrinterStatus status)
        {
            if (status.Offline || status.CoverOpen || status.ReceiptPaperEmpty || status.CutterError || status.UnrecoverableError)
            {
                throw new InvalidOperationException(StatusSummary(status));
            }
        }

        private static string NormalizeDeviceId(string value)
        {
            var trimmed = (value ?? "").Trim();
            if (trimmed.Length == 0) return "";
            if (trimmed.StartsWith("USB:", StringComparison.OrdinalIgnoreCase))
            {
                return "USBPRN:" + trimmed.Substring(4).Trim();
            }
            if (trimmed.IndexOf(':') >= 0 || trimmed.StartsWith("COM", StringComparison.OrdinalIgnoreCase))
            {
                return trimmed;
            }
            return "USBPRN:" + trimmed;
        }

        private static string CacheFilePath()
        {
            var root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(root, "LBj POS", "Printer Modules", "star-tsp100-device.txt");
        }

        private static string ReadCachedDeviceId()
        {
            try
            {
                var path = CacheFilePath();
                return File.Exists(path) ? NormalizeDeviceId(File.ReadAllText(path, Encoding.UTF8)) : "";
            }
            catch
            {
                return "";
            }
        }

        private static void WriteCachedDeviceId(string deviceId)
        {
            try
            {
                var path = CacheFilePath();
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                File.WriteAllText(path, NormalizeDeviceId(deviceId), new UTF8Encoding(false));
            }
            catch
            {
                // A read-only profile should not prevent printing.
            }
        }

        private static IDictionary<string, object> Success(
            string message,
            IDictionary<string, object> extra = null)
        {
            var response = new Dictionary<string, object>
            {
                { "ok", true },
                { "message", message }
            };
            if (extra != null)
            {
                foreach (var pair in extra) response[pair.Key] = pair.Value;
            }
            return response;
        }
    }
}
