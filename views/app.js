var app = angular.module('catsvsdogs', []);
var socket = io.connect();

var bg1 = document.getElementById('background-stats-1');
var bg2 = document.getElementById('background-stats-2');

app.controller('statsCtrl', function($scope){
  $scope.aPercent = 50;
  $scope.bPercent = 50;
  $scope.aCount = 0;
  $scope.bCount = 0;
  $scope.total = 0;

  $scope.lastUpdated = null;

  socket.on('scores', function (json) {
    var receivedAt = new Date();
    var data;
    try {
      data = JSON.parse(json);
    } catch (err) {
      return;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return;
    }
    var a = parseCount(data.a);
    var b = parseCount(data.b);
    if (a === null || b === null) {
      return;
    }

    var percentages = getPercentages(a, b);
    bg1.style.width = percentages.a + "%";
    bg2.style.width = percentages.b + "%";

    $scope.$apply(function () {
      $scope.aPercent = percentages.a;
      $scope.bPercent = percentages.b;
      $scope.aCount = a;
      $scope.bCount = b;
      $scope.total = a + b;
      $scope.lastUpdated = receivedAt.toISOString();
    });
  });
});

function parseCount(value) {
  value = value === undefined ? 0 : value;
  if (typeof value !== 'number' &&
      (typeof value !== 'string' || !/^\s*\d+\s*$/.test(value))) {
    return null;
  }
  var count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function getPercentages(a, b) {
  var result = {};

  if (a + b > 0) {
    result.a = Math.round(a / (a + b) * 100);
    result.b = 100 - result.a;
  } else {
    result.a = result.b = 50;
  }

  return result;
}