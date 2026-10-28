From Stdlib Require Import List.
Import ListNotations.

Theorem rev_rev : forall (A : Type) (l : list A), rev (rev l) = l.
Proof.
Admitted.
