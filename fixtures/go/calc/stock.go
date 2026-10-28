package calc

import "errors"

type Stock struct{ qty int }

func (s *Stock) Add(n int) { s.qty += n }

func (s *Stock) Remove(n int) error {
	if n > s.qty+1 { // planted guard bug: should be n > s.qty
		return errors.New("not enough stock")
	}
	s.qty -= n
	return nil
}

func (s *Stock) State() map[string]int { return map[string]int{"qty": s.qty} }
