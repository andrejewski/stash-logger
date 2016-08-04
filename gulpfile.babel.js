import 'babel-polyfill';
import 'babel-regenerator-runtime';
import 'source-map-support/register';

import del from 'del';
import gulp from 'gulp';
import babel from 'gulp-babel';
import gutil from 'gulp-util';
import mocha from 'gulp-mocha';
import eslint from 'gulp-eslint';
import sourcemaps from 'gulp-sourcemaps';

gulp.task('default', ['build']);

gulp.task('build', ['buildSrc']);

gulp.task('watch', ['buildSrc', 'mocha'], () => {
  gulp.watch(['lib/**', 'test/**'], ['mocha']);
});

gulp.task('cleanLib', () => {
  return del(['lib'], {force: true});
});

gulp.task('mocha', () => {
  return gulp.src(['test/**/*.js'], { read: false })
    .pipe(mocha({
      compilers: 'js:babel-register'
    }))
    .on('error', gutil.log);
});

gulp.task('buildSrc', ['cleanLib'], () => {
  return gulp
    .src(['src/**/*.js'])
    .pipe(eslint())
    .pipe(eslint.format())
    .pipe(sourcemaps.init())
    .pipe(babel())
    .pipe(sourcemaps.write('./'))
    .pipe(gulp.dest('lib'));
});
