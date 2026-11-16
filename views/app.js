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

  socket.on('scores', function (json) {
    var receivedAt = new Date();
    var data;
    var a;
    var b;
    try {
      data = JSON.parse(json);
      if (!data || typeof data !== 'object') {
        return;
      }
      a = parseInt(data.a, 10);
      b = parseInt(data.b, 10);
    } catch (error) {
      return;
    }
    if (!isFinite(a) || !isFinite(b) || a < 0 || b < 0) {
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
      $scope.lastUpdatedText = receivedAt.toLocaleString();
    });
  });
});

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