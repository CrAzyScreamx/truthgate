# truthgate shim (Python). Generic: no edits needed. Save as .truthgate/shims/truthgate_shim.py only to customise it.
# Run: <project python> truthgate_shim.py, with env TRUTHGATE_ROOT and TRUTHGATE_TARGET="path/to/file.py::name".
# Protocol (JSON Lines): in {"op":"call","fn":..,"input":{..},"observe"?:name} | {"op":"reset","args"?:[..]} | {"op":"state"}
#                        out {"out":..} | {"error":"msg","kind":"rejected|crash"}
# function specs: calls module-level `name` with the input values as positional args, in spec order.
#   observe: reply with that argument's value after the call (for functions that mutate it) instead of the return value.
# sequence specs: reset -> obj = name(*args); ops call obj.<op>(...); state -> obj.state() if defined, else vars(obj).
# Rejected (the function refused the input): ValueError, or any exception class named "Rejected"
#   (class Rejected(Exception): pass). Everything else, TypeError included, is a crash.
# JSON limits: ints stay int, decimals arrive as float; generators/iterators are drained to lists, tuples and sets
# become lists; anything else not JSON-serialisable (or NaN/inf) is a crash. A target that fails to import, or a
# missing function, exits with a one-line reason (shim error).
import collections.abc, importlib.util, json, os, sys

root = os.environ["TRUTHGATE_ROOT"]
path, name = os.environ["TRUTHGATE_TARGET"].rsplit("::", 1)
full = os.path.join(root, path)
sys.path[:0] = [os.path.dirname(full), root]
proto, sys.stdout = sys.stdout, sys.stderr  # user prints must not corrupt the protocol
try:
    spec = importlib.util.spec_from_file_location("truthgate_target", full)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
except Exception as e:
    sys.exit(f"truthgate shim: cannot load {path}: {type(e).__name__}: {e}")
if not callable(getattr(mod, name, None)):
    sys.exit(f"truthgate shim: {path} has no function or class {name}")
obj = None


def plain(v):
    if isinstance(v, (set, frozenset, collections.abc.Iterator)):
        return list(v)
    raise TypeError(f"{type(v).__name__} is not JSON serialisable")


def reply(m):
    try:
        text = json.dumps(m, allow_nan=False, default=plain)
    except (TypeError, ValueError) as e:
        text = json.dumps({"error": f"unserialisable output: {e}", "kind": "crash"})
    proto.write(text + "\n")
    proto.flush()


for line in sys.stdin:
    msg = json.loads(line)
    op = msg["op"]
    if op == "call":
        f = getattr(obj if obj is not None else mod, msg["fn"], None)
        if not callable(f):
            sys.exit(f"truthgate shim: {msg['fn']} not found on {path}::{name}")
    try:
        if op == "reset":
            obj, out = getattr(mod, name)(*msg.get("args", [])), None
        elif op == "state":
            out = obj.state() if hasattr(obj, "state") else vars(obj)
        else:
            args = list(msg["input"].values())
            out = f(*args)
            if msg.get("observe"):
                out = args[list(msg["input"]).index(msg["observe"])]
            if isinstance(out, collections.abc.Iterator):
                out = list(out)  # drain here, so an error while generating counts as a crash of the call
    except Exception as e:
        rejected = isinstance(e, ValueError) or type(e).__name__ == "Rejected"
        reply({"error": f"{type(e).__name__}: {e}", "kind": "rejected" if rejected else "crash"})
    else:
        reply({"out": out})
