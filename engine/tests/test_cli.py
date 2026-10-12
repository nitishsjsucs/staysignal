from staysignal.cli import main


def test_cli_without_command_prints_help(capsys):
    assert main([]) == 0
    assert "StaySignal engine" in capsys.readouterr().out
