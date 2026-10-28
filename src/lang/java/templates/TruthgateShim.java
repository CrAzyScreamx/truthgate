// truthgate shim (Java). Generic, reflection-based: no edits needed. Save as .truthgate/shims/TruthgateShim.java only to customise it.
// Needs JDK 17+. Run: java -cp <classes> TruthgateShim.java  (source launcher). truthgate first compiles the target with
//   javac -d <tmp> -sourcepath <source root> <target file>; set spec.shim.command if you need your build's classpath.
// Target: env TRUTHGATE_CLASS (fully qualified). function specs: a public static method by name and arity.
// sequence specs: reset -> new Class(); ops -> public instance methods; state -> state() if present, else the object's fields.
// Protocol (JSON Lines): in {"op":"call","fn":..,"input":{..}} | {"op":"reset"} | {"op":"state"}; out {"out":..} | {"error":..,"kind":..}
// IllegalArgumentException thrown by your code -> rejected; any other Throwable -> crash. A missing method exits (shim error).
// JSON limits: ints arrive as long and are narrowed to int/short/byte params; decimals as double (or float).
// Params may be primitives/boxed, String, List<T>, T[], Map<String,Object>. Outputs: null, Boolean, Number, String,
// Character, Enum, Map, Collection, arrays, records, else the object's fields. NaN/Infinity -> crash.
import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class TruthgateShim {
  static Class<?> cls;
  static Object obj;

  @SuppressWarnings("unchecked")
  public static void main(String[] args) throws Exception {
    PrintStream proto = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
    System.setOut(System.err); // user prints must not corrupt the protocol
    cls = Class.forName(System.getenv("TRUTHGATE_CLASS"));
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    for (String line; (line = in.readLine()) != null; ) {
      Map<String, Object> m = (Map<String, Object>) new P(line).val();
      String reply;
      try {
        Object out = switch ((String) m.get("op")) {
          case "reset" -> { obj = cls.getDeclaredConstructor().newInstance(); yield null; }
          case "state" -> state();
          default -> call((String) m.get("fn"), (Map<String, Object>) m.get("input"));
        };
        reply = "{\"out\":" + w(out) + "}";
      } catch (Throwable e) {
        boolean user = e instanceof InvocationTargetException;
        Throwable c = user ? e.getCause() : e;
        reply = "{\"error\":" + q(c.toString()) + ",\"kind\":\"" + (user && c instanceof IllegalArgumentException ? "rejected" : "crash") + "\"}";
      }
      proto.println(reply);
    }
  }

  static Object call(String fn, Map<String, Object> input) throws Exception {
    Object[] vals = input.values().toArray();
    for (Method m : cls.getMethods()) {
      boolean stat = Modifier.isStatic(m.getModifiers());
      if (!m.getName().equals(fn) || m.getParameterCount() != vals.length || (!stat && obj == null)) continue;
      Type[] ts = m.getGenericParameterTypes();
      Object[] a = new Object[vals.length];
      for (int i = 0; i < a.length; i++) a[i] = conv(vals[i], ts[i]);
      return m.invoke(stat ? null : obj, a);
    }
    System.err.println("truthgate shim: no public method " + fn + "/" + vals.length + " on " + cls.getName());
    System.exit(3);
    return null;
  }

  static Object state() throws Exception {
    try {
      return cls.getMethod("state").invoke(obj);
    } catch (NoSuchMethodException e) {
      return obj;
    }
  }

  static Object conv(Object v, Type t) {
    Class<?> c = t instanceof Class<?> k ? k : t instanceof ParameterizedType p ? (Class<?>) p.getRawType() : Object.class;
    if (v instanceof Number n) {
      if (c == int.class || c == Integer.class) return n.intValue();
      if (c == long.class || c == Long.class) return n.longValue();
      if (c == double.class || c == Double.class) return n.doubleValue();
      if (c == float.class || c == Float.class) return n.floatValue();
      if (c == short.class || c == Short.class) return n.shortValue();
      if (c == byte.class || c == Byte.class) return n.byteValue();
    }
    if (v instanceof List<?> l && c.isArray()) {
      Object arr = Array.newInstance(c.getComponentType(), l.size());
      for (int i = 0; i < l.size(); i++) Array.set(arr, i, conv(l.get(i), c.getComponentType()));
      return arr;
    }
    if (v instanceof List<?> l && t instanceof ParameterizedType p) {
      List<Object> r = new ArrayList<>();
      for (Object x : l) r.add(conv(x, p.getActualTypeArguments()[0]));
      return r;
    }
    return v;
  }

  static String q(String s) {
    StringBuilder b = new StringBuilder("\"");
    for (char c : s.toCharArray()) {
      if (c == '"' || c == '\\') b.append('\\').append(c);
      else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
      else b.append(c);
    }
    return b.append('"').toString();
  }

  static String w(Object v) throws Exception {
    if (v == null) return "null";
    if (v instanceof Boolean || v instanceof Integer || v instanceof Long || v instanceof Short || v instanceof Byte) return v.toString();
    if (v instanceof Number n) {
      double d = n.doubleValue();
      if (!Double.isFinite(d)) throw new ArithmeticException("non-finite number in output");
      return Double.toString(d);
    }
    if (v instanceof CharSequence || v instanceof Character || v instanceof Enum<?>) return q(v.toString());
    StringJoiner j;
    if (v instanceof Map<?, ?> m) {
      j = new StringJoiner(",", "{", "}");
      for (Map.Entry<?, ?> e : m.entrySet()) j.add(q(String.valueOf(e.getKey())) + ":" + w(e.getValue()));
      return j.toString();
    }
    j = new StringJoiner(",", "[", "]");
    if (v instanceof Iterable<?> it) {
      for (Object x : it) j.add(w(x));
      return j.toString();
    }
    if (v.getClass().isArray()) {
      for (int i = 0; i < Array.getLength(v); i++) j.add(w(Array.get(v, i)));
      return j.toString();
    }
    Map<String, Object> f = new LinkedHashMap<>();
    if (v instanceof Record) for (RecordComponent rc : v.getClass().getRecordComponents()) f.put(rc.getName(), rc.getAccessor().invoke(v));
    else for (Field fd : v.getClass().getDeclaredFields()) {
      if (Modifier.isStatic(fd.getModifiers())) continue;
      fd.setAccessible(true);
      f.put(fd.getName(), fd.get(v));
    }
    return w(f);
  }

  /** Minimal JSON reader: objects keep key order (spec input order). */
  static class P {
    final String s;
    int i;
    P(String s) { this.s = s; }
    void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
    Object val() {
      ws();
      char c = s.charAt(i);
      if (c == '{') {
        Map<String, Object> m = new LinkedHashMap<>();
        i++; ws();
        if (s.charAt(i) == '}') { i++; return m; }
        do { ws(); String k = str(); ws(); i++; m.put(k, val()); ws(); } while (s.charAt(i++) == ',');
        return m;
      }
      if (c == '[') {
        List<Object> l = new ArrayList<>();
        i++; ws();
        if (s.charAt(i) == ']') { i++; return l; }
        do { l.add(val()); ws(); } while (s.charAt(i++) == ',');
        return l;
      }
      if (c == '"') return str();
      for (String k : new String[] {"true", "false", "null"}) if (s.startsWith(k, i)) { i += k.length(); return k.equals("null") ? null : k.equals("true"); }
      int st = i;
      while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
      String n = s.substring(st, i);
      return n.matches("-?\\d+") ? (Object) Long.parseLong(n) : (Object) Double.parseDouble(n);
    }
    String str() {
      StringBuilder b = new StringBuilder();
      i++;
      for (char c; (c = s.charAt(i++)) != '"'; ) {
        if (c != '\\') { b.append(c); continue; }
        c = s.charAt(i++);
        switch (c) {
          case 'n' -> b.append('\n');
          case 't' -> b.append('\t');
          case 'r' -> b.append('\r');
          case 'b' -> b.append('\b');
          case 'f' -> b.append('\f');
          case 'u' -> { b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; }
          default -> b.append(c);
        }
      }
      return b.toString();
    }
  }
}
