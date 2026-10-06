"""`scripts/create.py`: the family's `make create` contract, parsed and then refused until the gesture is written."""

import pytest

from scripts.create import NOT_YET, main, parse_args


class TestParseArgs:
    def test_reads_the_whole_contract(self):
        args = parse_args(
            [
                "bundles/cv",
                "--name",
                "cv",
                "--title",
                "CV",
                "--description",
                "Screens a CV.",
                "--pipe",
                "screen",
                "--author-name",
                "Ada",
                "--author-email",
                "ada@example.com",
                "--repo-url",
                "https://example.com/cv",
                "--license",
                "mit",
                "--license-holder",
                "Ada",
                "--license-year",
                "2026",
                "--dry-run",
            ]
        )
        assert args.method == "bundles/cv"
        assert (args.name, args.title, args.description, args.pipe) == ("cv", "CV", "Screens a CV.", "screen")
        assert (args.author_name, args.author_email, args.repo_url) == ("Ada", "ada@example.com", "https://example.com/cv")
        assert (args.license, args.license_holder, args.license_year) == ("mit", "Ada", "2026")
        assert args.dry_run is True

    def test_requires_the_method(self):
        with pytest.raises(SystemExit) as caught:
            parse_args([])
        assert caught.value.code == 2


class TestMain:
    def test_refuses_and_changes_nothing(self, capsys: pytest.CaptureFixture[str]):
        assert main(["bundles/cv"]) == 1
        captured = capsys.readouterr()
        assert captured.out == ""
        assert NOT_YET in captured.err
