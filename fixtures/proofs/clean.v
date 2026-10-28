(* Clean proof: no Admitted, no Axiom (mentioning them in a comment is fine). *)
From Stdlib Require Import List.
Import ListNotations.

Theorem rev_rev : forall (A : Type) (l : list A), rev (rev l) = l.
Proof.
  intros A l. apply rev_involutive.
Qed.
