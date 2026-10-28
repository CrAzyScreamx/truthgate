def total(xs):
    t = 0
    for x in xs:
        t += x
    return t


def total_buggy(xs):
    t = 0
    for i in range(len(xs) - 1):  # planted off-by-one: skips the last item
        t += xs[i]
    return t
