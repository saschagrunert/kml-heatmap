"""Tests for CLI module."""

import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest


class TestPrintHelp:
    """Tests for print_help function."""

    def test_print_help_output(self, capsys):
        """Test that help text is printed."""
        from kml_heatmap.cli import print_help

        print_help()
        captured = capsys.readouterr()

        # Verify key sections are in help text
        assert "KML Heatmap Generator" in captured.out
        assert "USAGE:" in captured.out
        assert "OPTIONS:" in captured.out
        assert "EXAMPLES:" in captured.out
        assert "--output-dir" in captured.out
        assert "--debug" in captured.out
        assert "--help" in captured.out


class TestMainCLI:
    """Tests for main CLI function."""

    def test_no_arguments_shows_help(self, capsys):
        """Test that running with no arguments shows help and exits."""
        from kml_heatmap.cli import main

        with patch("sys.argv", ["kml-heatmap.py"]):
            with pytest.raises(SystemExit) as exc_info:
                main()

            assert exc_info.value.code == 1
            captured = capsys.readouterr()
            assert "KML Heatmap Generator" in captured.out

    def test_help_flag_short(self, capsys):
        """Test -h flag shows help and exits successfully."""
        from kml_heatmap.cli import main

        with patch("sys.argv", ["kml-heatmap.py", "-h"]):
            with pytest.raises(SystemExit) as exc_info:
                main()

            assert exc_info.value.code == 0
            captured = capsys.readouterr()
            assert "KML Heatmap Generator" in captured.out

    def test_help_flag_long(self, capsys):
        """Test --help flag shows help and exits successfully."""
        from kml_heatmap.cli import main

        with patch("sys.argv", ["kml-heatmap.py", "--help"]):
            with pytest.raises(SystemExit) as exc_info:
                main()

            assert exc_info.value.code == 0
            captured = capsys.readouterr()
            assert "KML Heatmap Generator" in captured.out

    def test_debug_flag_enables_debug_mode(self):
        """Test that --debug flag enables debug mode."""
        from kml_heatmap.cli import main

        with tempfile.TemporaryDirectory() as tmpdir:
            test_kml = Path(tmpdir) / "test.kml"
            test_kml.write_text("<?xml version='1.0'?><kml></kml>")

            mock_create = MagicMock(return_value=True)
            mock_module = MagicMock()
            mock_module.create_progressive_heatmap = mock_create

            with patch("sys.argv", ["kml-heatmap.py", "--debug", str(test_kml)]):
                with patch("kml_heatmap.cli.set_debug_mode") as mock_set_debug:
                    with patch.dict(
                        "sys.modules", {"kml_heatmap_original": mock_module}
                    ):
                        main()

                    mock_set_debug.assert_called_once_with(True)

    def test_output_dir_option(self):
        """Test --output-dir option."""
        from kml_heatmap.cli import main

        with tempfile.TemporaryDirectory() as tmpdir:
            test_kml = Path(tmpdir) / "test.kml"
            test_kml.write_text("<?xml version='1.0'?><kml></kml>")
            output_dir = Path(tmpdir) / "output"

            mock_create = MagicMock(return_value=True)
            mock_module = MagicMock()
            mock_module.create_progressive_heatmap = mock_create

            with patch(
                "sys.argv",
                ["kml-heatmap.py", str(test_kml), "--output-dir", str(output_dir)],
            ):
                with patch.dict("sys.modules", {"kml_heatmap_original": mock_module}):
                    main()

                assert mock_create.called
                call_args = mock_create.call_args
                assert str(output_dir / "index.html") in str(call_args)

    def test_output_dir_without_argument_exits(self, capsys):
        """Test --output-dir without directory name exits with error."""
        from kml_heatmap.cli import main

        with patch("sys.argv", ["kml-heatmap.py", "file.kml", "--output-dir"]):
            with pytest.raises(SystemExit) as exc_info:
                main()

            assert exc_info.value.code == 1
            captured = capsys.readouterr()
            assert "Error: --output-dir requires a directory name" in captured.out

    def test_unknown_option_exits(self):
        """Test unknown option exits with error."""
        from kml_heatmap.cli import main

        with patch("sys.argv", ["kml-heatmap.py", "--unknown-option"]):
            with pytest.raises(SystemExit) as exc_info:
                main()

            assert exc_info.value.code == 1

    def test_single_kml_file(self):
        """Test processing a single KML file."""
        from kml_heatmap.cli import main

        with tempfile.TemporaryDirectory() as tmpdir:
            test_kml = Path(tmpdir) / "test.kml"
            test_kml.write_text("<?xml version='1.0'?><kml></kml>")

            mock_create = MagicMock(return_value=True)
            mock_module = MagicMock()
            mock_module.create_progressive_heatmap = mock_create

            with patch("sys.argv", ["kml-heatmap.py", str(test_kml)]):
                with patch.dict("sys.modules", {"kml_heatmap_original": mock_module}):
                    main()

                assert mock_create.called
                kml_files = mock_create.call_args[0][0]
                assert str(test_kml) in str(kml_files)

    def test_multiple_kml_files(self):
        """Test processing multiple KML files."""
        from kml_heatmap.cli import main

        with tempfile.TemporaryDirectory() as tmpdir:
            test_kml1 = Path(tmpdir) / "test1.kml"
            test_kml2 = Path(tmpdir) / "test2.kml"
            test_kml1.write_text("<?xml version='1.0'?><kml></kml>")
            test_kml2.write_text("<?xml version='1.0'?><kml></kml>")

            mock_create = MagicMock(return_value=True)
            mock_module = MagicMock()
            mock_module.create_progressive_heatmap = mock_create

            with patch("sys.argv", ["kml-heatmap.py", str(test_kml1), str(test_kml2)]):
                with patch.dict("sys.modules", {"kml_heatmap_original": mock_module}):
                    main()

                assert mock_create.called
                kml_files = mock_create.call_args[0][0]
                assert len(kml_files) == 2
                assert str(test_kml1) in kml_files
                assert str(test_kml2) in kml_files

    def test_directory_with_kml_files(self):
        """Test processing a directory containing KML files."""
        from kml_heatmap.cli import main

        with tempfile.TemporaryDirectory() as tmpdir:
            kml_dir = Path(tmpdir) / "kml_files"
            kml_dir.mkdir()
            (kml_dir / "flight1.kml").write_text("<?xml version='1.0'?><kml></kml>")
            (kml_dir / "flight2.kml").write_text("<?xml version='1.0'?><kml></kml>")
            (kml_dir / "flight3.KML").write_text("<?xml version='1.0'?><kml></kml>")
            (kml_dir / "readme.txt").write_text("Not a KML file")

            mock_create = MagicMock(return_value=True)
            mock_module = MagicMock()
            mock_module.create_progressive_heatmap = mock_create

            with patch("sys.argv", ["kml-heatmap.py", str(kml_dir)]):
                with patch.dict("sys.modules", {"kml_heatmap_original": mock_module}):
                    main()

                assert mock_create.called
                kml_files = mock_create.call_args[0][0]
                assert len(kml_files) == 3
                assert "flight1.kml" in kml_files[0]
                assert "flight2.kml" in kml_files[1]
                assert "flight3.KML" in kml_files[2]

    def test_directory_without_kml_files_exits(self):
        """Test directory without KML files exits with error."""
        from kml_heatmap.cli import main

        with tempfile.TemporaryDirectory() as tmpdir:
            empty_dir = Path(tmpdir) / "empty"
            empty_dir.mkdir()

            with patch("sys.argv", ["kml-heatmap.py", str(empty_dir)]):
                with pytest.raises(SystemExit) as exc_info:
                    main()

                assert exc_info.value.code == 1

    def test_nonexistent_file_shows_warning(self):
        """Test that nonexistent file shows warning but continues if other files exist."""
        from kml_heatmap.cli import main

        with tempfile.TemporaryDirectory() as tmpdir:
            test_kml = Path(tmpdir) / "exists.kml"
            test_kml.write_text("<?xml version='1.0'?><kml></kml>")
            nonexistent = Path(tmpdir) / "nonexistent.kml"

            mock_create = MagicMock(return_value=True)
            mock_module = MagicMock()
            mock_module.create_progressive_heatmap = mock_create

            with patch("sys.argv", ["kml-heatmap.py", str(nonexistent), str(test_kml)]):
                with patch.dict("sys.modules", {"kml_heatmap_original": mock_module}):
                    main()

                assert mock_create.called
                kml_files = mock_create.call_args[0][0]
                assert len(kml_files) == 1
                assert str(test_kml) in kml_files

    def test_no_valid_files_exits(self, capsys):
        """Test that no valid files exits with error."""
        from kml_heatmap.cli import main

        with tempfile.TemporaryDirectory() as tmpdir:
            nonexistent = Path(tmpdir) / "nonexistent.kml"

            with patch("sys.argv", ["kml-heatmap.py", str(nonexistent)]):
                with pytest.raises(SystemExit) as exc_info:
                    main()

                assert exc_info.value.code == 1
                captured = capsys.readouterr()
                assert "No KML files specified or found" in captured.out

    def test_processing_failure_exits(self):
        """Test that processing failure exits with code 1."""
        from kml_heatmap.cli import main

        with tempfile.TemporaryDirectory() as tmpdir:
            test_kml = Path(tmpdir) / "test.kml"
            test_kml.write_text("<?xml version='1.0'?><kml></kml>")

            mock_create = MagicMock(return_value=False)
            mock_module = MagicMock()
            mock_module.create_progressive_heatmap = mock_create

            with patch("sys.argv", ["kml-heatmap.py", str(test_kml)]):
                with patch.dict("sys.modules", {"kml_heatmap_original": mock_module}):
                    with pytest.raises(SystemExit) as exc_info:
                        main()

                    assert exc_info.value.code == 1

    def test_output_directory_created(self):
        """Test that output directory is created if it doesn't exist."""
        from kml_heatmap.cli import main

        with tempfile.TemporaryDirectory() as tmpdir:
            test_kml = Path(tmpdir) / "test.kml"
            test_kml.write_text("<?xml version='1.0'?><kml></kml>")
            output_dir = Path(tmpdir) / "new_output_dir"
            assert not output_dir.exists()

            mock_create = MagicMock(return_value=True)
            mock_module = MagicMock()
            mock_module.create_progressive_heatmap = mock_create

            with patch(
                "sys.argv",
                ["kml-heatmap.py", str(test_kml), "--output-dir", str(output_dir)],
            ):
                with patch.dict("sys.modules", {"kml_heatmap_original": mock_module}):
                    main()

            assert output_dir.exists()
            assert output_dir.is_dir()

    def test_mixed_files_and_directories(self):
        """Test processing mix of files and directories."""
        from kml_heatmap.cli import main

        with tempfile.TemporaryDirectory() as tmpdir:
            file1 = Path(tmpdir) / "standalone.kml"
            file1.write_text("<?xml version='1.0'?><kml></kml>")

            kml_dir = Path(tmpdir) / "kml_files"
            kml_dir.mkdir()
            (kml_dir / "dir_file1.kml").write_text("<?xml version='1.0'?><kml></kml>")
            (kml_dir / "dir_file2.kml").write_text("<?xml version='1.0'?><kml></kml>")

            mock_create = MagicMock(return_value=True)
            mock_module = MagicMock()
            mock_module.create_progressive_heatmap = mock_create

            with patch("sys.argv", ["kml-heatmap.py", str(file1), str(kml_dir)]):
                with patch.dict("sys.modules", {"kml_heatmap_original": mock_module}):
                    main()

                assert mock_create.called
                kml_files = mock_create.call_args[0][0]
                assert len(kml_files) == 3
