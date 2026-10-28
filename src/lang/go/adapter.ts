import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type { LanguageAdapter, Spec } from '../../contract.ts';
import { probe } from '../../runner/proc.ts';
import { openShim } from '../../runner/shim.ts';
import { buildThenRun, missingShim, safeId, shimCommand, splitTarget } from '../common.ts';

const posix = (p: string) => p.split('\\').join('/');

/** Directory holding go.mod, from the target's directory up to the root. */
function moduleDir(root: string, file: string): string {
  for (let d = dirname(resolve(root, file)); ; d = dirname(d)) {
    if (existsSync(join(d, 'go.mod'))) return d;
    if (d === resolve(root) || dirname(d) === d) return resolve(root);
  }
}

function shimPath(spec: Spec, root: string) {
  const { file } = splitTarget(spec);
  const mod = moduleDir(root, file);
  const dir = posix(relative(resolve(root), mod));
  return { mod, rel: `truthgate_shim/${safeId(spec.id)}`, path: `${dir ? `${dir}/` : ''}truthgate_shim/${safeId(spec.id)}/main.go` };
}

export function goTemplate(spec: Spec, root: string): { path: string; source: string } {
  const { file, name } = splitTarget(spec);
  const { mod, rel, path } = shimPath(spec, root);
  const gomod = existsSync(join(mod, 'go.mod')) ? readFileSync(join(mod, 'go.mod'), 'utf8') : '';
  const modPath = /^module\s+(\S+)/m.exec(gomod)?.[1] ?? 'example.com/yourmodule // TODO: your module path';
  const pkg = posix(relative(mod, dirname(resolve(root, file))));
  const seq = spec.kind === 'sequence';
  return {
    path,
    source: `// truthgate shim (Go) for spec "${spec.id}". Save as ${path} (inside your module).
// truthgate builds it with \`go build ./${rel}\` from the module root and runs the binary, one long-lived process per spec run.
// Protocol (JSON Lines): in {"op":"call","fn":..,"input":{..}} | {"op":"reset"} | {"op":"state"}; out {"out":..} | {"error":..,"kind":..}
// Inputs are decoded with encoding/json into each parameter's type, positionally in spec order
// (int -> any int type, decimal -> float64, str -> string, bool -> bool, list<T> -> []T, record -> struct or map).
// A trailing non-nil error result -> rejected; a panic -> crash; several results come back as a JSON list.
// sequence specs: reset -> a new *${name}; ops call its methods (add -> Add); state -> its State() method, else the value.
// Unexported struct fields are invisible to encoding/json: return them from State().
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"

	target "${pkg && pkg !== '.' ? `${modPath}/${pkg}` : modPath}"
)

var fns = map[string]any{${seq ? '' : `"${name}": target.${name}`}}

func reset() any { return ${seq ? `&target.${name}{}` : 'nil'} }

var errType = reflect.TypeOf((*error)(nil)).Elem()

func main() {
	proto := bufio.NewWriter(os.Stdout)
	os.Stdout = os.Stderr // user prints must not corrupt the protocol
	var obj any
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1<<20), 1<<26)
	for sc.Scan() {
		var msg struct {
			Op, Fn string
			Input  json.RawMessage
		}
		if err := json.Unmarshal(sc.Bytes(), &msg); err != nil {
			die("bad request: " + err.Error())
		}
		var reply map[string]any
		switch msg.Op {
		case "reset":
			obj, reply = reset(), map[string]any{"out": nil}
		case "state":
			reply = do(func() (any, error) {
				if m := reflect.ValueOf(obj).MethodByName("State"); m.IsValid() {
					return call(m, nil)
				}
				return obj, nil
			})
		default:
			f := fnOf(obj, msg.Fn)
			reply = do(func() (any, error) { return call(f, args(msg.Input)) })
		}
		b, err := json.Marshal(reply)
		if err != nil {
			b, _ = json.Marshal(map[string]any{"error": "unserialisable output: " + err.Error(), "kind": "crash"})
		}
		proto.Write(append(b, '\\n'))
		proto.Flush()
	}
}

func die(msg string) {
	fmt.Fprintln(os.Stderr, "truthgate shim:", msg)
	os.Exit(3)
}

func do(f func() (any, error)) (reply map[string]any) {
	defer func() {
		if p := recover(); p != nil {
			reply = map[string]any{"error": fmt.Sprint("panic: ", p), "kind": "crash"}
		}
	}()
	out, err := f()
	if err != nil {
		return map[string]any{"error": err.Error(), "kind": "rejected"}
	}
	return map[string]any{"out": out}
}

func fnOf(obj any, name string) reflect.Value {
	if obj == nil {
		if f, ok := fns[name]; ok {
			return reflect.ValueOf(f)
		}
	} else if name != "" {
		v := reflect.ValueOf(obj)
		for _, n := range []string{name, strings.ToUpper(name[:1]) + name[1:]} {
			if m := v.MethodByName(n); m.IsValid() {
				return m
			}
		}
	}
	die("no function " + name)
	return reflect.Value{}
}

// args returns the input object's values in key order (spec order).
func args(raw json.RawMessage) []json.RawMessage {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.Token()
	var vals []json.RawMessage
	for dec.More() {
		dec.Token()
		var v json.RawMessage
		dec.Decode(&v)
		vals = append(vals, v)
	}
	return vals
}

func call(f reflect.Value, in []json.RawMessage) (any, error) {
	t := f.Type()
	if t.NumIn() != len(in) {
		die(fmt.Sprintf("arity mismatch: want %d args, got %d", t.NumIn(), len(in)))
	}
	a := make([]reflect.Value, len(in))
	for i := range in {
		p := reflect.New(t.In(i))
		if err := json.Unmarshal(in[i], p.Interface()); err != nil {
			die(fmt.Sprintf("arg %d: %v", i, err))
		}
		a[i] = p.Elem()
	}
	res := f.Call(a)
	if n := len(res); n > 0 && t.Out(n-1) == errType {
		if !res[n-1].IsNil() {
			return nil, res[n-1].Interface().(error)
		}
		res = res[:n-1]
	}
	switch len(res) {
	case 0:
		return nil, nil
	case 1:
		return res[0].Interface(), nil
	}
	outs := make([]any, len(res))
	for i, r := range res {
		outs[i] = r.Interface()
	}
	return outs, nil
}
`,
  };
}

export const goAdapter: LanguageAdapter = {
  lang: 'go',
  available: (root) => probe(['go', 'version'], 'go', root),
  async open(spec, root) {
    const { mod, rel, path } = shimPath(spec, root);
    if (spec.shim) {
      const { command, cwd } = shimCommand(spec, root, join(root, path), []);
      return openShim(command, cwd);
    }
    if (!existsSync(join(root, path))) throw missingShim(spec, path);
    const tmp = await mkdtemp(join(tmpdir(), 'truthgate-go-'));
    const bin = join(tmp, process.platform === 'win32' ? 'shim.exe' : 'shim');
    return buildThenRun(['go', 'build', '-o', bin, `./${rel}`], mod, () => [bin], { tmp, what: 'go build' });
  },
  shimTemplate: (spec: Spec, root = process.cwd()) => goTemplate(spec, root),
  testFileGlobs: ['**/*_test.go'],
  skipMarkers: [/\b[tbf]\.Skip(f|Now)?\s*\(/],
  assertPatterns: [/\bt\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(/, /\b(assert|require)\.\w+\s*\(/],
  lineComment: '//',
};
