"""Template structure checks; runtime visibility is verified on the deployment."""

from html.parser import HTMLParser
from pathlib import Path
import unittest


class Element:
    def __init__(self, tag, attrs=()):
        self.tag = tag
        self.attrs = dict(attrs)
        self.children = []

    def text(self):
        return "".join(child.text() if isinstance(child, Element) else child
                       for child in self.children)

    def elements(self):
        for child in self.children:
            if isinstance(child, Element):
                yield child
                yield from child.elements()


class PageParser(HTMLParser):
    VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input",
                 "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.root = Element("document")
        self.stack = [self.root]
        self.feed(source)
        self.close()

    def handle_starttag(self, tag, attrs):
        element = Element(tag, attrs)
        self.stack[-1].children.append(element)
        if tag not in self.VOID_TAGS:
            self.stack.append(element)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self.stack[-1].tag != tag:
            raise ValueError("Unexpected closing tag: " + tag)
        self.stack.pop()

    def handle_data(self, data):
        self.stack[-1].children.append(data)


class PageStructureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        template = Path(__file__).resolve().parents[1] / "views" / "index.html"
        cls.page = PageParser(template.read_text(encoding="utf-8")).root

    def one(self, nodes):
        self.assertEqual(len(nodes), 1)
        return nodes[0]

    def by_id(self, element_id):
        return self.one([node for node in self.page.elements()
                         if node.attrs.get("id") == element_id])

    def test_unique_semantic_heading_and_exact_text(self):
        heading = self.one([node for node in self.page.elements() if node.tag == "h1"])
        self.assertIs(heading, self.by_id("results-heading"))
        self.assertEqual(heading.text(), "实时投票结果")

    def test_heading_precedes_vote_area_in_same_container(self):
        center = self.by_id("content-container-center")
        siblings = [node for node in center.children if isinstance(node, Element)]
        self.assertIn(self.by_id("results-heading"), siblings)
        self.assertIn(self.by_id("choice"), siblings)
        self.assertLess(siblings.index(self.by_id("results-heading")),
                        siblings.index(self.by_id("choice")))

    def test_original_document_title(self):
        title = self.one([node for node in self.page.elements() if node.tag == "title"])
        self.assertEqual(title.text(), "猫派 vs 狗派 -- Result")

    def test_both_options_counts_and_percentages_keep_bindings(self):
        choice = self.by_id("choice")
        for option, label, count_id, count, percent in (
                ("cats", "猫派", "count-a", "{{aCount}}", "{{aPercent | number:1}}%"),
                ("dogs", "狗派", "count-b", "{{bCount}}", "{{bPercent | number:1}}%")):
            with self.subTest(option=option):
                side = self.one([node for node in choice.elements()
                                 if option in node.attrs.get("class", "").split()])
                nodes = list(side.elements())
                self.assertEqual(self.one([node for node in nodes
                                           if node.attrs.get("class") == "label"]).text(), label)
                self.assertIn(self.by_id(count_id), nodes)
                self.assertEqual(self.by_id(count_id).text(), count)
                self.assertEqual(self.one([node for node in nodes
                                           if node.attrs.get("class") == "stat"]).text(), percent)

    def test_total_and_initialization_hooks_remain(self):
        total_nodes = list(self.by_id("result").elements())
        self.assertIn(self.by_id("total-label"), total_nodes)
        self.assertIn(self.by_id("total-count"), total_nodes)
        self.assertEqual(self.by_id("total-label").text(), "总票数")
        self.assertEqual(self.by_id("total-count").text(), "{{total}}")
        html = self.one([node for node in self.page.elements() if node.tag == "html"])
        self.assertEqual(html.attrs.get("ng-app"), "catsvsdogs")
        body = self.one([node for node in self.page.elements() if node.tag == "body"])
        self.assertEqual(body.attrs.get("ng-controller"), "statsCtrl")
        self.assertEqual([node.attrs.get("src") for node in body.elements()
                          if node.tag == "script"],
                         ["socket.io.js", "angular.min.js", "app.js"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
