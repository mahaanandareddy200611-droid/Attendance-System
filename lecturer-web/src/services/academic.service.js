import api from "../api/api";

export const createCourse = (data) => api.post("/academic/courses", data);

export const createSection = (data) => api.post("/academic/sections", data);

export const enrollStudent = (data) => api.post("/academic/enrollments", data);

export const getSectionStudents = (sectionId) => {
  const encodedSectionId = encodeURIComponent(sectionId);
  return api.get(`/academic/sections/${encodedSectionId}/students`);
};
