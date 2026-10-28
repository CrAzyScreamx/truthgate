// truthgate shim (Go) for spec "total.ok". Save as truthgate_shim/total_ok/main.go (inside your module).
// truthgate runs `go run ./truthgate_shim/total_ok` from the module root, one long-lived process per spec run.
// Protocol (JSON Lines): in {"op":"call","fn":..,"input":{..}} | {"op":"reset"} | {"op":"state"}; out {"out":..} | {"error":..,"kind":..}
// Inputs are decoded with encoding/json into each parameter's type, positionally in spec order
// (int -> any int type, decimal -> float64, str -> string, bool -> bool, list<T> -> []T, record -> struct or map).
// A trailing non-nil error result -> rejected; a panic -> crash; several results come back as a JSON list.
// sequence specs: reset -> a new *Total; ops call its methods (add -> Add); state -> its State() method, else the value.
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

	target "truthgate.local/fixture/calc"
)

var fns = map[string]any{"Total": target.Total}

func reset() any { return nil }

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
		proto.Write(append(b, '\n'))
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
