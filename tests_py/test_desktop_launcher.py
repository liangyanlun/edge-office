from __future__ import annotations

import desktop_launcher


def test_port_probe_skips_a_port_already_in_use(monkeypatch):
    attempted = []

    class Probe:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def bind(self, address):
            attempted.append(address)
            if address[1] == 4173:
                raise OSError("port in use")

    monkeypatch.setattr(desktop_launcher.socket, "socket", lambda *_args: Probe())
    assert desktop_launcher.find_available_port() == 4174
    assert attempted == [("127.0.0.1", 4173), ("127.0.0.1", 4174)]
