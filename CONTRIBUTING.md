# Contributing

Contributions are welcome. The software in this repository is released under the Facilitator License 1.0.0, and anything you contribute becomes part of the software under that license.

By submitting a contribution to this repository, you grant Akash Satpathy (the licensor) a perpetual, worldwide, non-exclusive, irrevocable, royalty-free right to use, copy, modify, distribute, sublicense and relicense your contribution as part of the software, under any terms. This is what lets the license on the software change later without tracking down every past contributor for permission.

You keep the copyright in your own contribution. You are granting a right to use it, not handing it over.

You confirm that the contribution is your own work and that you have the right to grant this.

## Releases

Updates install only commits on main signed by a key listed in `app/update-signers`, as that file stands in the version already installed (see [Updating](docs/install.md#updating)). A release is a signed merge of premain, made on main:

```
git merge --no-ff -S premain
```

`--no-ff` makes sure there is a merge commit to sign, and `-S` signs it. Commits on main that are not signed, such as the README banner refresh and edits made on GitHub's website, ride along with the next signed merge, so look at what main has that premain does not (`git diff --stat premain...main`) before signing. `git -c gpg.ssh.allowedSignersFile=app/update-signers verify-commit HEAD` then checks the merge the way an update will.

`app/update-signers` must hold the maintainer's public key before anything is pushed to main: pushed with no key in it, every update after it stops with "No release signing key is listed yet". A change to the file counts only from a commit signed by a key already listed.
