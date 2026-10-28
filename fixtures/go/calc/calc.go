package calc

func Total(xs []int) int {
	t := 0
	for _, x := range xs {
		t += x
	}
	return t
}

func TotalBuggy(xs []int) int {
	t := 0
	for i := 0; i < len(xs)-1; i++ { // planted off-by-one: skips the last item
		t += xs[i]
	}
	return t
}
