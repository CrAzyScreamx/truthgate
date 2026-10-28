// truthgate shim (C#). Generic, reflection-based: no edits needed. Save as .truthgate/shims/TruthgateShim.cs only to customise it.
// truthgate builds it as a tiny console project (in the OS temp dir) that references your csproj:
//   dotnet build <tmp>/TruthgateShim.csproj -o <tmp>/out, then runs `dotnet <tmp>/out/TruthgateShim.dll`.
// Target: env TRUTHGATE_ASSEMBLY + TRUTHGATE_CLASS (type name or full name).
// function specs: a public static method by name (case-insensitive) and arity, on the class named like the file.
// sequence specs: reset -> new T(); ops -> public instance methods (add -> Add); state -> State() if present, else the object.
// Protocol (JSON Lines): in {"op":"call","fn":..,"input":{..}} | {"op":"reset"} | {"op":"state"}; out {"out":..} | {"error":..,"kind":..}
// ArgumentException thrown by your code -> rejected; any other exception -> crash. A missing method exits (shim error).
// JSON limits: each input is deserialised by System.Text.Json into the parameter's type (int, long, double, decimal,
// string, bool, List<T>, T[], records ...); outputs are serialised the same way (fields included). NaN/Infinity -> crash.
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;

var asm = Assembly.Load(Environment.GetEnvironmentVariable("TRUTHGATE_ASSEMBLY")!);
var cls = Environment.GetEnvironmentVariable("TRUTHGATE_CLASS")!;
var type = asm.GetTypes().First(t => t.FullName == cls || t.Name == cls);
var proto = Console.Out;
Console.SetOut(Console.Error); // user prints must not corrupt the protocol
var opts = new JsonSerializerOptions { IncludeFields = true };
object? obj = null;
for (string? line; (line = Console.In.ReadLine()) != null;)
{
    var msg = JsonNode.Parse(line)!.AsObject();
    string reply;
    try
    {
        object? output = null;
        switch ((string)msg["op"]!)
        {
            case "reset":
                obj = Activator.CreateInstance(type);
                break;
            case "state":
                var sm = type.GetMethod("State", Type.EmptyTypes) ?? type.GetMethod("state", Type.EmptyTypes);
                output = sm != null ? sm.Invoke(obj, null) : obj;
                break;
            default:
                var fn = (string)msg["fn"]!;
                var input = msg["input"]!.AsObject().Select(kv => kv.Value).ToArray();
                var m = type.GetMethods().FirstOrDefault(x => string.Equals(x.Name, fn, StringComparison.OrdinalIgnoreCase)
                    && x.GetParameters().Length == input.Length && (x.IsStatic || obj != null));
                if (m == null)
                {
                    Console.Error.WriteLine($"truthgate shim: no public method {fn}/{input.Length} on {type.FullName}");
                    return 3;
                }
                var argv = m.GetParameters().Select((p, i) => input[i]?.Deserialize(p.ParameterType, opts)).ToArray();
                output = m.Invoke(m.IsStatic ? null : obj, argv);
                break;
        }
        reply = JsonSerializer.Serialize(new Dictionary<string, object?> { ["out"] = output }, opts);
    }
    catch (Exception e)
    {
        var user = e is TargetInvocationException;
        var c = user ? e.InnerException! : e;
        reply = JsonSerializer.Serialize(new { error = $"{c.GetType().Name}: {c.Message}", kind = user && c is ArgumentException ? "rejected" : "crash" });
    }
    proto.WriteLine(reply);
    proto.Flush();
}
return 0;
